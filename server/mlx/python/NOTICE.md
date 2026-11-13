`kda.py` is vendored from Qingyan-QLab/ssm-mlx at
`ed27c0f3d84dbbae2b8fd7468b0978e8fcd602ea` (2026-11-13).
It implements the standard FLA KDA checkpoint layout, including the OmniFM
text export and offset RMSNorm. The source repository's project ownership
and distribution terms continue to apply; no third-party license is assigned here.

The worker uses the pinned MLX-LM public loading/generation APIs and its
text state machine. It never imports Python files from a downloaded model.
