"""MLX-LM model for the standard FLA KDAForCausalLM checkpoint layout."""

import math
from dataclasses import dataclass

import mlx.core as mx
import mlx.nn as nn
from mlx_lm.models.activations import swiglu
from mlx_lm.models.base import BaseModelArgs, create_ssm_mask
from mlx_lm.models.cache import ArraysCache
from mlx_lm.models.gated_delta import (
    compute_g, compute_lower_bound_g, gated_delta_update, normalize_qk,
)


def _make_short_conv_kernel(parts):
    """Depthwise causal conv + SiLU reading history and input separately.

    The channel axis is split into `parts` contiguous outputs (template
    C0, C1, ...), so a fused q/k/v projection needs one dispatch and no
    concatenation or slicing copies.
    """
    if not mx.metal.is_available():
        return None
    stores = {
        1: "out0[index] = result;",
        3: """
            uint row = b * T + t;
            if (c < C0) out0[row * C0 + c] = result;
            else if (c < C0 + C1) out1[row * C1 + c - C0] = result;
            else out2[row * (C - C0 - C1) + c - C0 - C1] = result;
        """,
    }[parts]
    return mx.fast.metal_kernel(
        name=f"kda_short_conv_{parts}",
        input_names=["history", "x", "weight"],
        output_names=[f"out{part}" for part in range(parts)] + ["tail"],
        source=r"""
            uint index = thread_position_in_grid.x;
            if (index >= B * T * C) return;
            uint c = index % C;
            uint t = (index / C) % T;
            uint b = index / (C * T);
            float value = 0;
            for (uint j = 0; j < K; ++j) {
                uint w = t + j;
                float s = (w < K - 1) ? float(history[(b * (K - 1) + w) * C + c])
                                      : float(x[(b * T + w - (K - 1)) * C + c]);
                value += s * float(weight[c * K + j]);
            }
            // Preserve Conv1d's output rounding and MLX sigmoid arithmetic.
            InT rounded = InT(value);
            auto inverse = 1 / (1 + metal::precise::exp(metal::abs(rounded)));
            InT gate = (rounded < 0) ? inverse : 1 - inverse;
            InT result = InT(float(rounded) * float(gate));
            """ + stores + r"""
            if (t == 0) {
                for (uint j = 0; j < K - 1; ++j) {
                    uint w = T + j;
                    tail[(b * (K - 1) + j) * C + c] = (w < K - 1)
                        ? history[(b * (K - 1) + w) * C + c]
                        : x[(b * T + w - (K - 1)) * C + c];
                }
            }
        """,
    )


_short_conv_kernels = {parts: _make_short_conv_kernel(parts) for parts in (1, 3)}


def _make_chunk_prepare_kernel():
    if not mx.metal.is_available():
        return None
    return mx.fast.metal_kernel(
        name="kda_chunk_prepare",
        input_names=["q", "k", "g", "beta"],
        output_names=["read_coeff", "write_coeff", "query_decay", "key_decay", "key_end", "end_decay"],
        source=r"""
            uint lane = thread_index_in_simdgroup;
            uint row = thread_position_in_grid.y;
            uint group = thread_position_in_grid.z;
            uint block = group % N;
            uint h = (group / N) % Hv;
            uint b = group / (N * Hv);
            uint hk = h / (Hv / Hk);
            uint t = block * C + row;
            constexpr uint E = Dk / 32;
            float decay[E];
            float qi[E];
            float ki[E];
            for (uint e = 0; e < E; ++e) {
                uint d = lane * E + e;
                qi[e] = float(q[((b * T + t) * Hk + hk) * Dk + d]);
                ki[e] = float(k[((b * T + t) * Hk + hk) * Dk + d]);
                decay[e] = 1;
            }
            float update = beta[(b * T + t) * Hv + h];
            for (int col = int(row); col >= 0; --col) {
                uint s = block * C + col;
                float a = 0;
                float c = 0;
                for (uint e = 0; e < E; ++e) {
                    uint d = lane * E + e;
                    float kj = float(k[((b * T + s) * Hk + hk) * Dk + d]);
                    a += qi[e] * decay[e] * kj;
                    c += ki[e] * decay[e] * kj;
                    if (row == C - 1) {
                        key_end[(group * C + col) * Dk + d] = decay[e] * kj;
                    }
                    decay[e] *= g[((b * T + s) * Hv + h) * Dk + d];
                }
                a = simd_sum(a);
                c = simd_sum(c);
                if (lane == 0) {
                    read_coeff[(group * C + row) * C + col] = a;
                    write_coeff[(group * C + row) * C + col] = (col < row) ? update * c : 0;
                }
            }
            if (lane == 0) {
                for (uint col = row + 1; col < C; ++col) {
                    read_coeff[(group * C + row) * C + col] = 0;
                    write_coeff[(group * C + row) * C + col] = 0;
                }
            }
            for (uint e = 0; e < E; ++e) {
                uint d = lane * E + e;
                query_decay[(group * C + row) * Dk + d] = qi[e] * decay[e];
                key_decay[(group * C + row) * Dk + d] = update * ki[e] * decay[e];
                if (row == C - 1) end_decay[group * Dk + d] = decay[e];
            }
        """,
    )


def _make_chunk_carry_kernel():
    if not mx.metal.is_available():
        return None
    return mx.fast.metal_kernel(
        name="kda_chunk_carry",
        input_names=[
            "kg", "v_beta", "qg", "read_coeff", "write_coeff",
            "key_end_t", "end_decay", "state_in",
        ],
        output_names=["out", "state_out"],
        source=r"""
            uint head = thread_position_in_grid.z;
            uint value = thread_position_in_grid.y * 8;
            if (value >= Dv) return;
            uint lane = thread_index_in_simdgroup;
            uint quad = lane / 4;
            // Coordinates of the two entries owned by this lane in an 8x8 tile.
            uint row_element = (quad & 4) + ((lane / 2) % 4);
            uint col_element = (quad & 2) * 2 + (lane % 2) * 2;
            simdgroup_float8x8 state[Dk / 8];
            for (uint d = 0; d < Dk; d += 8) {
                simdgroup_load(state[d / 8],
                    state_in + (head * Dv + value) * Dk + d,
                    Dk, ulong2(0, 0), true);
            }
            // A SIMD group owns eight value channels. State stays in registers
            // across all blocks, with matrix instructions operating on 8 tokens.
            for (uint block = 0; block < N; ++block) {
                uint group = head * N + block;
                simdgroup_float8x8 lower;
                simdgroup_load(lower, write_coeff + group * C * C, C);
                auto inverse = make_filled_simdgroup_matrix<float, 8>(0.f);
                inverse.thread_elements()[0] = row_element == col_element ? 1.f : 0.f;
                inverse.thread_elements()[1] = row_element == col_element + 1 ? 1.f : 0.f;
                inverse.thread_elements()[0] -= lower.thread_elements()[0];
                inverse.thread_elements()[1] -= lower.thread_elements()[1];
                // L^8 = 0, so (I+L)^-1 = (I-L)(I+L^2)(I+L^4).
                for (uint power = 2; power < C; power *= 2) {
                    simdgroup_multiply(lower, lower, lower);
                    simdgroup_multiply_accumulate(inverse, inverse, lower, inverse);
                }
                auto predicted = make_filled_simdgroup_matrix<float, 8>(0.f);
                for (uint d = 0; d < Dk; d += 8) {
                    simdgroup_float8x8 key;
                    simdgroup_load(key, kg + group * C * Dk + d, Dk);
                    simdgroup_multiply_accumulate(predicted, key, state[d / 8], predicted);
                }
                simdgroup_float8x8 delta;
                simdgroup_load(delta, v_beta + group * C * Dv + value, Dv);
                delta.thread_elements()[0] -= predicted.thread_elements()[0];
                delta.thread_elements()[1] -= predicted.thread_elements()[1];
                simdgroup_multiply(delta, inverse, delta);

                auto result = make_filled_simdgroup_matrix<float, 8>(0.f);
                for (uint d = 0; d < Dk; d += 8) {
                    simdgroup_float8x8 query;
                    simdgroup_load(query, qg + group * C * Dk + d, Dk);
                    simdgroup_multiply_accumulate(result, query, state[d / 8], result);
                }
                simdgroup_float8x8 coefficient;
                simdgroup_load(coefficient, read_coeff + group * C * C, C);
                simdgroup_multiply_accumulate(result, coefficient, delta, result);
                simdgroup_store(result, out + group * C * Dv + value, Dv);

                for (uint d = 0; d < Dk; d += 8) {
                    float decay = end_decay[group * Dk + d + row_element];
                    state[d / 8].thread_elements()[0] *= decay;
                    state[d / 8].thread_elements()[1] *= decay;
                    simdgroup_float8x8 key;
                    simdgroup_load(key, key_end_t + (group * Dk + d) * C, C);
                    simdgroup_multiply_accumulate(state[d / 8], key, delta, state[d / 8]);
                }
            }
            for (uint d = 0; d < Dk; d += 8) {
                simdgroup_store(state[d / 8],
                    state_out + (head * Dv + value) * Dk + d,
                    Dk, ulong2(0, 0), true);
            }
        """,
    )


_chunk_prepare_kernel = _make_chunk_prepare_kernel()
_chunk_carry_kernel = _make_chunk_carry_kernel()


@mx.compile
def chunk_kda(q, k, v, g, beta, state):
    """Eight-token KDA blocks with FP32 state and Metal matrix arithmetic.

    q/k are already normalized. g contains decay factors in [0, 1].
    Each block solves (I + L) delta = beta*v - KG*state, then reads
    QG*state + A*delta and carries G_end*state + K_end.T*delta.
    The preparation kernel forms relative decays by multiplication, so
    zero/underflowed gates never require a reciprocal or log subtraction.
    """
    batch, length, key_heads, key_dim = q.shape
    value_heads, value_dim = v.shape[-2:]
    chunk_size = 8
    blocks = (length + chunk_size - 1) // chunk_size
    padded_length = blocks * chunk_size
    padding = padded_length - length
    if padding:
        time_padding = ((0, 0), (0, padding), (0, 0), (0, 0))
        q, k, v = (mx.pad(x, time_padding) for x in (q, k, v))
        g = mx.pad(g, time_padding, constant_values=1)
        beta = mx.pad(beta, ((0, 0), (0, padding), (0, 0)))
    matrix_shape = (batch, value_heads, blocks, chunk_size, chunk_size)
    vector_shape = (batch, value_heads, blocks, chunk_size, key_dim)
    read_coeff, write_coeff, query_decay, key_decay, key_end, end_decay = _chunk_prepare_kernel(
        inputs=[q, k, g, beta],
        template=[
            ("T", padded_length), ("N", blocks), ("C", chunk_size),
            ("Hk", key_heads), ("Hv", value_heads), ("Dk", key_dim),
        ],
        grid=(32, chunk_size, batch * value_heads * blocks),
        threadgroup=(32, 4, 1),
        output_shapes=[
            matrix_shape, matrix_shape, vector_shape, vector_shape, vector_shape,
            (batch, value_heads, blocks, key_dim),
        ],
        output_dtypes=[mx.float32] * 6,
    )
    values = (beta[..., None] * v.astype(mx.float32)).transpose(0, 2, 1, 3)
    values = values.reshape(batch, value_heads, blocks, chunk_size, value_dim)
    out, state = _chunk_carry_kernel(
        inputs=[key_decay, values, query_decay, read_coeff, write_coeff,
                key_end.swapaxes(-1, -2), end_decay, state],
        template=[("C", chunk_size), ("N", blocks), ("Dk", key_dim), ("Dv", value_dim)],
        grid=(32, value_dim // 8, batch * value_heads),
        threadgroup=(32, 4, 1),
        output_shapes=[(batch, value_heads, blocks, chunk_size, value_dim), state.shape],
        output_dtypes=[mx.float32, mx.float32],
    )
    out = out.reshape(batch, value_heads, padded_length, value_dim).transpose(0, 2, 1, 3)
    return out[:, :length].astype(q.dtype), state


def kda_update(q, k, v, a, b, A_log, dt_bias, state=None, mask=None, *,
               lower_bound=None, allow_neg_eigval=False, use_chunked_prefill=True):
    if (
        use_chunked_prefill
        and q.shape[1] >= 128
        and q.shape[-1] % 32 == 0
        and v.shape[-1] % 8 == 0
        and (state is None or state.dtype == mx.float32)
        and _chunk_prepare_kernel is not None
        and mx.default_device() == mx.gpu
    ):
        beta = mx.sigmoid(b) * (2.0 if allow_neg_eigval else 1.0)
        g = (compute_g(A_log, a, dt_bias) if lower_bound is None else
             compute_lower_bound_g(A_log, a, dt_bias, lower_bound))
        if state is None:
            state = mx.zeros((q.shape[0], v.shape[2], v.shape[3], k.shape[3]), mx.float32)
        if mask is not None:
            q = mx.where(mask[..., None, None], q, 0)
            g = mx.where(mask[..., None, None], g, 1)
            beta = mx.where(mask[..., None], beta, 0)
        return chunk_kda(q, k, v, g, beta, state)
    return gated_delta_update(
        q, k, v, a, b, A_log, dt_bias, state=state, mask=mask,
        lower_bound=lower_bound, allow_neg_eigval=allow_neg_eigval,
    )


def linear(layer, x, dense_min_rows=None):
    """Apply a (possibly quantized) linear layer.

    For quantized layers and at least `dense_min_rows` input rows, the weight
    is dequantized for this call and a BF16 GEMM is used instead of the
    quantized matmul. That is faster for long prefill chunks; the dequantized
    weight is a temporary and is freed after the matmul.
    """
    rows = x.size // x.shape[-1]
    if (
        dense_min_rows is None
        or rows < dense_min_rows
        or not isinstance(layer, nn.QuantizedLinear)
        or layer.mode != "affine"
    ):
        return layer(x)
    weight = mx.dequantize(
        layer["weight"], layer["scales"], layer.get("biases"),
        group_size=layer.group_size, bits=layer.bits, mode=layer.mode,
    ).astype(x.dtype)
    out = x @ weight.T
    if "bias" in layer:
        out = out + layer["bias"]
    return out


def _make_fused_decode_kernel():
    """One single-token KDA step per (batch, value head) threadgroup.

    Replaces, for decode: short conv + SiLU, q/k L2 normalization, the forget
    and update gates, the gated delta recurrence, o_norm and the sigmoid output
    gate. Rounding to InT follows the unfused path at the same points (conv
    output, normalized q/k, recurrence output, final output); reductions use a
    different order, so results match within floating-point rounding.
    """
    if not mx.metal.is_available():
        return None
    return mx.fast.metal_kernel(
        name="kda_fused_decode",
        input_names=[
            "qkv", "conv_in", "conv_w", "forget", "update", "A_log", "dt_bias",
            "state_in", "gate", "o_weight", "params",
        ],
        output_names=["out", "state_out", "conv_out"],
        source=r"""
            constexpr uint lanes_per_row = 4;
            constexpr uint per_lane = Dk / lanes_per_row;
            constexpr uint groups = Dv / 8;
            threadgroup float sq[Dk];
            threadgroup float sk[Dk];
            threadgroup float sv[Dv];
            threadgroup float sg[Dk];
            threadgroup float partial[groups];
            threadgroup float shared_beta;

            uint lane = thread_index_in_simdgroup;
            uint simd = simdgroup_index_in_threadgroup;
            uint tid = simd * 32 + lane;
            uint n = threadgroup_position_in_grid.z;
            uint b = n / Hv;
            uint hv = n % Hv;
            uint hk = hv / (Hv / Hk);
            float lower_bound = params[0];
            float o_eps = params[1];

            // Short causal conv + SiLU for this head's q, k and v channels.
            if (tid < 2 * Dk + Dv) {
                uint c = tid < Dk ? hk * Dk + tid
                       : tid < 2 * Dk ? Hk * Dk + hk * Dk + (tid - Dk)
                       : 2 * Hk * Dk + hv * Dv + (tid - 2 * Dk);
                float value = 0;
                for (uint j = 0; j < K; ++j) {
                    float s = (j < K - 1) ? float(conv_in[(b * (K - 1) + j) * C + c])
                                          : float(qkv[b * C + c]);
                    value += s * float(conv_w[c * K + j]);
                }
                InT rounded = InT(value);
                auto inverse = 1 / (1 + metal::precise::exp(metal::abs(rounded)));
                InT act = (rounded < 0) ? inverse : 1 - inverse;
                float result = float(InT(float(rounded) * float(act)));
                if (tid < Dk) sq[tid] = result;
                else if (tid < 2 * Dk) sk[tid - Dk] = result;
                else sv[tid - 2 * Dk] = result;
                // Shift the conv history. Threadgroups sharing a key head write
                // identical q/k values.
                for (uint j = 0; j + 1 < K - 1; ++j) {
                    conv_out[(b * (K - 1) + j) * C + c] = conv_in[(b * (K - 1) + j + 1) * C + c];
                }
                conv_out[(b * (K - 1) + K - 2) * C + c] = qkv[b * C + c];
            }
            // Gates for this value head.
            if (tid < Dk) {
                float a = float(forget[(b * Hv + hv) * Dk + tid]) + float(dt_bias[hv * Dk + tid]);
                float scale = metal::precise::exp(float(A_log[hv]));
                float g;
                if (HasLowerBound) {
                    g = metal::precise::exp(lower_bound / (1 + metal::precise::exp(-scale * a)));
                } else {
                    float softplus = metal::max(a, 0.0f) + metal::precise::log(1 + metal::precise::exp(-metal::abs(a)));
                    g = metal::precise::exp(-scale * softplus);
                }
                sg[tid] = g;
            }
            if (tid == 0) {
                float x = float(update[b * Hv + hv]);
                shared_beta = (NegEigval ? 2.0f : 1.0f) / (1 + metal::precise::exp(-x));
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);

            // L2-normalize q (with the Dk^-0.5 readout scale folded in) and k.
            if (simd < 2) {
                threadgroup float* x = simd == 0 ? sq : sk;
                float sum = 0;
                for (uint e = lane; e < Dk; e += 32) sum += x[e] * x[e];
                sum = simd_sum(sum);
                float inv_scale = metal::rsqrt(float(Dk));
                float inv2 = inv_scale * inv_scale;
                float r = metal::rsqrt(sum / Dk + 1e-6f * inv2);
                float factor = simd == 0 ? inv2 : inv_scale;
                for (uint e = lane; e < Dk; e += 32) {
                    x[e] = float(InT(float(InT(x[e] * r)) * factor));
                }
            }
            threadgroup_barrier(mem_flags::mem_threadgroup);

            // Gated delta step: 8 value rows per SIMD group, 4 lanes per row.
            uint row = simd * 8 + lane / lanes_per_row;
            uint part = lane % lanes_per_row;
            uint base = part * per_lane;
            auto i_state = state_in + ((b * Hv + hv) * Dv + row) * Dk + base;
            auto o_state = state_out + ((b * Hv + hv) * Dv + row) * Dk + base;
            float st[per_lane];
            float kv = 0;
            for (uint e = 0; e < per_lane; ++e) {
                st[e] = i_state[e] * sg[base + e];
                kv += st[e] * sk[base + e];
            }
            kv += simd_shuffle_xor(kv, 1);
            kv += simd_shuffle_xor(kv, 2);
            float delta = (sv[row] - kv) * shared_beta;
            float y = 0;
            for (uint e = 0; e < per_lane; ++e) {
                st[e] += sk[base + e] * delta;
                y += st[e] * sq[base + e];
                o_state[e] = st[e];
            }
            y += simd_shuffle_xor(y, 1);
            y += simd_shuffle_xor(y, 2);

            // o_norm over the head's Dv outputs, then the sigmoid output gate.
            float yr = float(InT(y));
            float sq_sum = simd_sum(part == 0 ? yr * yr : 0.0f);
            if (lane == 0) partial[simd] = sq_sum;
            threadgroup_barrier(mem_flags::mem_threadgroup);
            float total = 0;
            for (uint i = 0; i < groups; ++i) total += partial[i];
            if (part == 0) {
                float normalized = yr * metal::rsqrt(total / Dv + o_eps) * float(o_weight[row]);
                float gv = float(gate[(b * Hv + hv) * Dv + row]);
                out[(b * Hv + hv) * Dv + row] = InT(normalized / (1 + metal::precise::exp(-gv)));
            }
        """,
    )


_fused_decode_kernel = _make_fused_decode_kernel()


@dataclass
class ModelArgs(BaseModelArgs):
    model_type: str = "kda"
    hidden_size: int = 2048
    num_hidden_layers: int = 24
    vocab_size: int = 32000
    head_dim: int = 128
    num_heads: int = 16
    num_v_heads: int | None = None
    expand_v: float = 1.0
    intermediate_size: int | None = None
    hidden_ratio: int | None = 4
    hidden_act: str = "swish"
    norm_eps: float = 1e-6
    norm_parameterization: str = "scale"
    use_short_conv: bool = True
    conv_size: int = 4
    safe_gate: bool = False
    lower_bound: float | None = None
    allow_neg_eigval: bool = False
    tie_word_embeddings: bool = False
    attn: dict | list | None = None
    attnres_block_size: int | None = None
    compile_decode: bool = True
    use_chunked_prefill: bool = True
    # Single-token decode through one Metal kernel per layer for conv, q/k
    # norm, gates, recurrence and gated o_norm.
    fused_decode: bool = True
    # Dequantize Q4 weights per call and use BF16 GEMM for chunks with at
    # least this many rows; None keeps the quantized matmul everywhere.
    dense_prefill_min_tokens: int | None = 1024

    def __post_init__(self):
        if self.model_type != "kda":
            raise ValueError("Expected FLA model_type='kda'.")
        hybrid_layers = self.attn
        if isinstance(hybrid_layers, dict):
            hybrid_layers = hybrid_layers.get("layers", hybrid_layers)
        if hybrid_layers or self.attnres_block_size is not None:
            raise ValueError("This adapter requires pure KDA with ordinary residuals.")
        if self.hidden_act != "swish":
            raise ValueError("This adapter requires FLA's standard SwiGLU MLP.")
        if self.norm_parameterization not in {"scale", "offset"}:
            raise ValueError("Expected scale or offset RMSNorm.")
        if self.safe_gate and self.lower_bound is None:
            raise ValueError("safe_gate requires lower_bound.")
        if self.lower_bound is not None and self.lower_bound >= 0:
            raise ValueError("lower_bound must be negative.")
        if self.num_v_heads is None:
            self.num_v_heads = self.num_heads
        if self.num_heads < 1 or self.num_v_heads < 1 or self.num_v_heads % self.num_heads:
            raise ValueError("num_v_heads must be a positive multiple of num_heads.")
        if self.head_dim < 1 or self.expand_v <= 0:
            raise ValueError("head_dim and expand_v must be positive.")
        value_head_dim = self.head_dim * self.expand_v
        if not math.isclose(value_head_dim, int(value_head_dim), rel_tol=1e-5):
            raise ValueError("head_dim * expand_v must be an integer.")
        if self.use_short_conv and self.conv_size < 1:
            raise ValueError("conv_size must be positive.")
        if self.intermediate_size is None:
            ratio = 4 if self.hidden_ratio is None else self.hidden_ratio
            width = int(self.hidden_size * ratio * 2 / 3)
            self.intermediate_size = 256 * ((width + 255) // 256)


class ShortConv(nn.Conv1d):
    """Depthwise causal conv + SiLU with cached history.

    With `splits`, the channel axis is returned as separate contiguous arrays
    (a tuple); otherwise a single array is returned.
    """

    def __init__(self, channels, kernel_size, splits=None):
        super().__init__(channels, channels, kernel_size, groups=channels, bias=False)
        self.history = kernel_size - 1
        self.splits = None if splits is None else tuple(splits)
        if self.splits is not None and (len(self.splits) != 3 or sum(self.splits) != channels):
            raise ValueError("splits must be three widths summing to channels.")

    def __call__(self, x, state, mask, lengths):
        if mask is not None:
            x = mx.where(mask[..., None], x, 0)
        batch, length, channels = x.shape
        if state is None:
            state = mx.zeros((batch, self.history, channels), dtype=x.dtype)
        parts = 1 if self.splits is None else 3
        kernel = _short_conv_kernels[parts]
        window = None
        if kernel is not None and mx.default_device() == mx.gpu and x.dtype == self.weight.dtype:
            widths = (channels,) if self.splits is None else self.splits
            *out, tail = kernel(
                # A zero-width history is never read; pass x as a placeholder.
                inputs=[state if self.history else x, x, self.weight],
                template=[
                    ("InT", x.dtype), ("B", batch), ("T", length), ("C", channels),
                    ("K", self.history + 1), ("C0", widths[0]),
                    ("C1", widths[1] if parts == 3 else 0),
                ],
                grid=(batch * length * channels, 1, 1),
                threadgroup=(256, 1, 1),
                output_shapes=[(batch, length, w) for w in widths]
                + [(batch, self.history, channels)],
                output_dtypes=[x.dtype] * (parts + 1),
            )
        else:
            window = mx.concatenate((state, x), axis=1)
            full = nn.silu(super().__call__(window))
            out = ([full] if self.splits is None else
                   mx.split(full, [self.splits[0], self.splits[0] + self.splits[1]], axis=-1))
            tail = mx.contiguous(window[:, window.shape[1] - self.history :])
        if lengths is not None:
            if window is None:
                window = mx.concatenate((state, x), axis=1)
            ends = mx.clip(lengths, 0, length)
            indices = (ends[:, None] + mx.arange(self.history))[..., None]
            tail = mx.contiguous(mx.take_along_axis(window, indices, axis=1))
        return (out[0] if self.splits is None else tuple(out)), tail


class KimiDeltaAttention(nn.Module):
    def __init__(self, args):
        super().__init__()
        self.num_heads = args.num_heads
        self.num_v_heads = args.num_v_heads
        self.key_head_dim = args.head_dim
        self.value_head_dim = int(args.head_dim * args.expand_v)
        self.lower_bound = args.lower_bound
        self.allow_neg_eigval = args.allow_neg_eigval
        self.use_short_conv = args.use_short_conv
        self.use_chunked_prefill = args.use_chunked_prefill
        self.fused_decode = args.fused_decode
        self.dense_min = args.dense_prefill_min_tokens
        self.conv_size = args.conv_size
        self.norm_eps = args.norm_eps

        hidden = args.hidden_size
        key_dim = self.num_heads * self.key_head_dim
        value_dim = self.num_v_heads * self.value_head_dim
        gate_dim = self.num_v_heads * self.key_head_dim
        # Projections that read the same input are stored concatenated along
        # the output axis (see Model.sanitize) and run as one matmul.
        self.qkv_splits = (key_dim, key_dim, value_dim)
        self.qkv_proj = nn.Linear(hidden, sum(self.qkv_splits), bias=False)
        # f_proj.0 and g_proj.0 from the FLA layout, kept at source precision.
        # b_proj (16 outputs) stays separate.
        self.gates_in_proj = nn.Linear(hidden, 2 * self.value_head_dim, bias=False)
        self.b_proj = nn.Linear(hidden, self.num_v_heads, bias=False)
        self.f_proj = nn.Linear(self.value_head_dim, gate_dim, bias=False)
        self.g_proj = nn.Linear(self.value_head_dim, value_dim, bias=True)
        self.A_log = mx.zeros((self.num_v_heads,))
        self.dt_bias = mx.zeros((gate_dim,))
        self.o_norm = nn.RMSNorm(self.value_head_dim, eps=args.norm_eps)
        self.o_proj = nn.Linear(value_dim, hidden, bias=False)
        if self.use_short_conv:
            self.qkv_conv1d = ShortConv(sum(self.qkv_splits), args.conv_size, self.qkv_splits)

    def _can_fuse_decode(self, x, cache, mask):
        return (
            self.fused_decode
            and _fused_decode_kernel is not None
            and mx.default_device() == mx.gpu
            and cache is not None
            and mask is None
            and cache.lengths is None
            and x.shape[1] == 1
            and self.use_short_conv
            and self.conv_size >= 2
            and self.key_head_dim == 128
            and self.value_head_dim % 8 == 0
            and self.value_head_dim <= 256
            and (cache[0] is None or cache[0].dtype == mx.float32)
            and self.qkv_conv1d.weight.dtype == x.dtype
        )

    def _fused_decode(self, x, cache):
        batch = x.shape[0]
        qkv = self.qkv_proj(x)
        f_in, g_in = mx.split(self.gates_in_proj(x), 2, axis=-1)
        forget = self.f_proj(f_in)
        gate = self.g_proj(g_in)
        update = self.b_proj(x)
        channels = qkv.shape[-1]
        history = self.conv_size - 1
        conv_state = cache[1]
        if conv_state is None:
            conv_state = mx.zeros((batch, history, channels), x.dtype)
        state = cache[0]
        if state is None:
            state = mx.zeros(
                (batch, self.num_v_heads, self.value_head_dim, self.key_head_dim), mx.float32
            )
        params = mx.array(
            [0.0 if self.lower_bound is None else self.lower_bound, self.norm_eps], mx.float32
        )
        out, state, conv_state = _fused_decode_kernel(
            inputs=[qkv, conv_state, self.qkv_conv1d.weight, forget, update, self.A_log,
                    self.dt_bias, state, gate, self.o_norm.weight, params],
            template=[
                ("InT", x.dtype), ("Dk", self.key_head_dim), ("Dv", self.value_head_dim),
                ("Hk", self.num_heads), ("Hv", self.num_v_heads), ("K", self.conv_size),
                ("C", channels), ("HasLowerBound", self.lower_bound is not None),
                ("NegEigval", self.allow_neg_eigval),
            ],
            grid=(32, self.value_head_dim // 8, batch * self.num_v_heads),
            threadgroup=(32, self.value_head_dim // 8, 1),
            output_shapes=[(batch, 1, self.num_v_heads * self.value_head_dim),
                           state.shape, conv_state.shape],
            output_dtypes=[x.dtype, mx.float32, x.dtype],
        )
        cache[0], cache[1] = state, conv_state
        cache.advance(1)
        return self.o_proj(out)

    def __call__(self, x, cache=None):
        batch, length, _ = x.shape
        mask = create_ssm_mask(x, cache)
        if self._can_fuse_decode(x, cache, mask):
            return self._fused_decode(x, cache)
        state = None if cache is None else cache[0]
        qkv = linear(self.qkv_proj, x, self.dense_min)
        if self.use_short_conv:
            conv_state = None if cache is None else cache[1]
            lengths = None if cache is None else cache.lengths
            (q, k, v), conv_state = self.qkv_conv1d(qkv, conv_state, mask, lengths)
            if cache is not None:
                cache[1] = conv_state
        else:
            key_dim = self.qkv_splits[0]
            q, k, v = mx.split(nn.silu(qkv), [key_dim, 2 * key_dim], axis=-1)

        q = q.reshape(batch, length, self.num_heads, self.key_head_dim)
        k = k.reshape(batch, length, self.num_heads, self.key_head_dim)
        v = v.reshape(batch, length, self.num_v_heads, self.value_head_dim)
        q, k = normalize_qk(q, k, inv_scale=self.key_head_dim**-0.5, eps=1e-6)
        f_in, g_in = mx.split(self.gates_in_proj(x), 2, axis=-1)
        forget = self.f_proj(f_in).reshape(
            batch, length, self.num_v_heads, self.key_head_dim
        )
        out, state = kda_update(
            q,
            k,
            v,
            forget.astype(mx.float32),
            self.b_proj(x).astype(mx.float32),
            self.A_log[:, None],
            self.dt_bias.reshape(self.num_v_heads, self.key_head_dim),
            state=state,
            mask=mask,
            lower_bound=self.lower_bound,
            allow_neg_eigval=self.allow_neg_eigval,
            use_chunked_prefill=self.use_chunked_prefill,
        )
        if cache is not None:
            cache[0] = state
            cache.advance(length)

        gate = self.g_proj(g_in).reshape(v.shape)
        normalized = self.o_norm(out.astype(mx.float32))
        out = (normalized * mx.sigmoid(gate.astype(mx.float32))).astype(x.dtype)
        return linear(self.o_proj, out.reshape(batch, length, -1), self.dense_min)


class MLP(nn.Module):
    def __init__(self, args):
        super().__init__()
        self.dense_min = args.dense_prefill_min_tokens
        # gate_proj and up_proj concatenated along the output axis.
        self.gate_up_proj = nn.Linear(args.hidden_size, 2 * args.intermediate_size, bias=False)
        self.down_proj = nn.Linear(args.intermediate_size, args.hidden_size, bias=False)

    def __call__(self, x):
        gate, up = mx.split(linear(self.gate_up_proj, x, self.dense_min), 2, axis=-1)
        return linear(self.down_proj, swiglu(gate, up), self.dense_min)


class OffsetRMSNorm(nn.RMSNorm):
    def __init__(self, width, eps):
        super().__init__(width, eps=eps)
        self.weight = mx.zeros((width,))

    def __call__(self, x):
        scale = 1 + self.weight.astype(mx.float32)
        return mx.fast.rms_norm(x.astype(mx.float32), scale, self.eps).astype(x.dtype)


def backbone_norm(args):
    norm = OffsetRMSNorm if args.norm_parameterization == "offset" else nn.RMSNorm
    return norm(args.hidden_size, eps=args.norm_eps)


class KDABlock(nn.Module):
    def __init__(self, args):
        super().__init__()
        self.attn_norm = backbone_norm(args)
        self.attn = KimiDeltaAttention(args)
        self.mlp_norm = backbone_norm(args)
        self.mlp = MLP(args)

    def __call__(self, x, cache=None):
        x = x + self.attn(self.attn_norm(x), cache=cache)
        return x + self.mlp(self.mlp_norm(x))


class KDAModel(nn.Module):
    def __init__(self, args):
        super().__init__()
        self.embeddings = nn.Embedding(args.vocab_size, args.hidden_size)
        self.layers = [KDABlock(args) for _ in range(args.num_hidden_layers)]
        self.norm = backbone_norm(args)
        self.compile_decode = args.compile_decode
        # Capture live parameters so loading new weights also updates the graph.
        self._decode = mx.compile(self._forward_cached, inputs=self.state)

    def __call__(self, inputs, cache=None):
        if self.compile_decode and inputs.shape[1] == 1 and cache is not None:
            hidden, states = self._decode(inputs, [entry.state for entry in cache])
            for entry, state in zip(cache, states, strict=True):
                entry.state = state
            return hidden
        return self._forward(inputs, cache)

    def _forward_cached(self, inputs, states):
        # Only these local caches mutate during tracing. Request-owned caches
        # are updated by the caller, including padding and remaining lengths.
        cache = [ArraysCache(size=len(state[0])) for state in states]
        for entry, state in zip(cache, states, strict=True):
            entry.state = state
        hidden = self._forward(inputs, cache)
        return hidden, [entry.state for entry in cache]

    def _forward(self, inputs, cache=None):
        x = self.embeddings(inputs)
        if cache is None:
            cache = [None] * len(self.layers)
        for layer, layer_cache in zip(self.layers, cache, strict=True):
            x = layer(x, cache=layer_cache)
        return self.norm(x)


class Model(nn.Module):
    def __init__(self, args):
        super().__init__()
        self.args = args
        self.model_type = args.model_type
        self.model = KDAModel(args)
        if not args.tie_word_embeddings:
            self.lm_head = nn.Linear(args.hidden_size, args.vocab_size, bias=False)

    @property
    def layers(self):
        return self.model.layers

    def __call__(self, inputs, cache=None):
        hidden = self.model(inputs, cache=cache)
        if self.args.tie_word_embeddings:
            return self.model.embeddings.as_linear(hidden)
        return self.lm_head(hidden)

    def make_cache(self):
        # Recurrent state, then the fused q/k/v convolution history.
        size = 2 if self.args.use_short_conv else 1
        return [ArraysCache(size=size) for _ in self.layers]

    def sanitize(self, weights):
        weights = dict(weights)
        for name, weight in weights.items():
            if name.endswith("_conv1d.weight") and weight.ndim == 3 and weight.shape[1] == 1:
                # FLA uses [channels, 1, kernel], MLX [channels, kernel, 1].
                weights[name] = weight.transpose(0, 2, 1)

        def merge(sources, target):
            # Concatenate along the output axis. Affine quantization groups run
            # along the input axis, so packed weights, scales and biases of
            # already-quantized checkpoints concatenate the same way.
            if f"{sources[0]}.weight" not in weights:
                return  # Already in the fused layout.
            for suffix in ("weight", "scales", "biases", "bias"):
                names = [f"{source}.{suffix}" for source in sources]
                present = [name in weights for name in names]
                if not any(present):
                    continue
                if not all(present):
                    raise ValueError(f"Cannot fuse {sources}: '{suffix}' is missing for some.")
                weights[f"{target}.{suffix}"] = mx.concatenate(
                    [weights.pop(name) for name in names], axis=0
                )

        for index in range(self.args.num_hidden_layers):
            attn = f"model.layers.{index}.attn."
            mlp = f"model.layers.{index}.mlp."
            merge([attn + "q_proj", attn + "k_proj", attn + "v_proj"], attn + "qkv_proj")
            merge([attn + "q_conv1d", attn + "k_conv1d", attn + "v_conv1d"], attn + "qkv_conv1d")
            merge([attn + "f_proj.0", attn + "g_proj.0"], attn + "gates_in_proj")
            merge([mlp + "gate_proj", mlp + "up_proj"], mlp + "gate_up_proj")
            for name in ("f_proj", "g_proj"):
                for suffix in ("weight", "scales", "biases", "bias"):
                    old = f"{attn}{name}.1.{suffix}"
                    if old in weights:
                        weights[f"{attn}{name}.{suffix}"] = weights.pop(old)
        if self.args.tie_word_embeddings:
            head = weights.pop("lm_head.weight", None)
            if head is not None:
                embeddings = weights["model.embeddings.weight"]
                if head.shape != embeddings.shape or not mx.array_equal(head, embeddings).item():
                    raise ValueError("Tied lm_head and embeddings contain different weights.")
        return weights
