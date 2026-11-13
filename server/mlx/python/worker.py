import contextlib
import gc
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import uuid

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
wire = sys.stdout
sys.stdout = sys.stderr


def emit(value):
    wire.write(json.dumps(value, ensure_ascii=False) + "\n")
    wire.flush()


def check():
    for package, version in (("mlx", "0.32.4"), ("mlx-lm", "0.32.2"), ("transformers", "5.22.2")):
        if importlib.metadata.version(package) != version:
            raise ValueError(f"Install {package}=={version} in the selected Python environment.")
    import mlx.core as mx
    if not mx.metal.is_available():
        raise ValueError("MLX requires an Apple Silicon Mac with Metal.")


def load(path):
    from mlx_lm.utils import load_model, load_tokenizer
    config = json.loads((path / "config.json").read_text())
    if config.get("model_type") == "kda":
        import kda
        model, config = load_model(path, model_config={"model_file": None},
                                   get_model_classes=lambda config: (kda.Model, kda.ModelArgs))
    else:
        model, config = load_model(path, trust_remote_code=False)
    tokenizer = load_tokenizer(path, {"trust_remote_code": False, "local_files_only": True},
                               eos_token_ids=config.get("eos_token_id"))
    return model, tokenizer


def generate(model, tokenizer, request):
    from mlx_lm import stream_generate
    from mlx_lm.generate import TextStateMachine, make_text_state_machine
    from mlx_lm.sample_utils import make_sampler
    messages = request["messages"]
    tools = request.get("tools", [])
    if not messages or len(messages) > 4096:
        raise ValueError("Invalid conversation length.")
    for message in messages:
        if not isinstance(message.get("content"), (str, type(None))):
            raise ValueError("Local MLX currently accepts text only.")
        for call in message.get("tool_calls", []):
            args = call["function"].get("arguments")
            if isinstance(args, str):
                call["function"]["arguments"] = json.loads(args)
    native_tools = tokenizer.has_tool_calling
    if not native_tools:
        messages = [dict(message) for message in messages]
        for message in messages:
            message["content"] = message.get("content") or ""
            for call in message.pop("tool_calls", []):
                message["content"] += "<tool_call>" + json.dumps(call["function"], ensure_ascii=False) + "</tool_call>"
            if message["role"] == "tool":
                message["role"] = "user"
                message["content"] = "Tool result (" + message.get("tool_call_id", "") + "):\n" + message["content"]
    if tools and not native_tools:
        instruction = "Available tools: " + json.dumps(tools, ensure_ascii=False) + '\nTo use a tool, output <tool_call>{"name":"tool_name","arguments":{...}}</tool_call>. Wait for its result. Never invent a tool result.'
        messages = [{"role": "system", "content": instruction}] + messages
    kwargs = {"tools": tools} if tools and native_tools else {}
    if not tokenizer.chat_template:
        raise ValueError("This model has no chat template. Publish an instruct/chat tokenizer configuration.")
    prompt = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, **kwargs)
    if len(prompt) > 32768:
        raise ValueError("The local MLX conversation exceeds the 32K token limit. Start a new conversation.")
    initial = "normal"
    if tokenizer.has_thinking and tokenizer.rfind_think_start(prompt) > tokenizer.rfind_think_end(prompt):
        initial = "reasoning"
    initial = tokenizer.response_initial_state or initial
    sm = make_text_state_machine(tokenizer)
    if tools and not native_tools:
        sm = TextStateMachine({"normal": [("<tool_call>", "tool"), ("<think>", "reasoning")],
                               "tool": [("</tool_call>", "normal")], "reasoning": [("</think>", "normal")]})
    state = sm.make_state(initial)
    previous = initial
    tool_text = ""
    count = 0
    last = None
    for result in stream_generate(model, tokenizer, prompt,
                                  max_tokens=min(int(request.get("max_tokens", 2048)), 8192),
                                  sampler=make_sampler(temp=float(request.get("temperature", 0.6))),
                                  prefill_step_size=512):
        last = result
        state, segments = TextStateMachine.split(state, result.text)
        if result.finish_reason == "length":
            state, pending, tail = TextStateMachine.flush(state)
            segments.append((tail, pending))
        for current, text in segments:
            if previous == "tool" and current != "tool":
                parsed = tokenizer.tool_parser(tool_text, tools) if native_tools else json.loads(tool_text)
                for call in parsed if isinstance(parsed, list) else [parsed]:
                    if call["name"] not in [tool["function"]["name"] for tool in tools]:
                        raise ValueError("Model requested an unknown tool.")
                    emit({"delta": {"tool_calls": [{"index": count, "id": str(uuid.uuid4()), "type": "function",
                          "function": {"name": call["name"], "arguments": json.dumps(call["arguments"], ensure_ascii=False)}}]}})
                    count += 1
                tool_text = ""
            if current == "tool":
                tool_text += text
            elif current in ("normal", "reasoning") and text:
                emit({"delta": {"reasoning_content" if current == "reasoning" else "content": text}})
            previous = current
    if tool_text:
        raise ValueError("The model produced an incomplete tool call. Try again with a shorter request.")
    emit({"done": True, "finish_reason": "tool_calls" if count else (last.finish_reason if last else "stop"),
          "usage": {"prompt_tokens": last.prompt_tokens if last else len(prompt),
                    "completion_tokens": last.generation_tokens if last else 0}})


def main():
    check()
    if "--check" in sys.argv:
        emit({"ready": True})
        return
    model = tokenizer = None
    emit({"ready": True})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if request["op"] == "load":
                model = tokenizer = None
                gc.collect()
                import mlx.core as mx
                mx.clear_cache()
                model, tokenizer = load(Path(request["path"]))
                emit({"done": True})
            elif request["op"] == "generate" and model is not None:
                generate(model, tokenizer, request["body"])
            else:
                raise ValueError("Load a local model before generating.")
        except Exception as error:
            emit({"error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    with contextlib.redirect_stdout(sys.stderr):
        main()
