import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import worker


class Tokenizer:
    chat_template = "fixture"
    has_tool_calling = True
    has_thinking = False
    tool_call_start = "<tool_call>"
    tool_call_end = "</tool_call>"
    structural_markers = []
    response_transitions = {}
    response_initial_state = None
    has_response_format = False

    def apply_chat_template(self, messages, **kwargs):
        self.messages = messages
        return [1, 2]

    def tool_parser(self, text, tools):
        return json.loads(text)


class WorkerTest(unittest.TestCase):
    tools = [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]

    def generate(self, text, tokenizer=None, messages=None):
        tokenizer = tokenizer or Tokenizer()
        chunks = [text[i:i + 3] for i in range(0, len(text), 3)]
        results = [SimpleNamespace(text=chunk, finish_reason=None, prompt_tokens=2, generation_tokens=i + 1)
                   for i, chunk in enumerate(chunks)]
        results.append(SimpleNamespace(text="", finish_reason="stop", prompt_tokens=2, generation_tokens=len(chunks)))
        packets = []
        with patch("mlx_lm.stream_generate", return_value=iter(results)), patch.object(worker, "emit", packets.append):
            worker.generate(None, tokenizer, {"messages": messages or [{"role": "user", "content": "find it"}], "tools": self.tools})
        return packets

    def test_fragmented_native_tool_call(self):
        packets = self.generate('Searching.<tool_call>{"name":"lookup","arguments":{"query":"巴黎"}}</tool_call>')
        calls = [p["delta"]["tool_calls"][0] for p in packets if "tool_calls" in p.get("delta", {})]
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]), {"query": "巴黎"})
        self.assertEqual(packets[-1]["finish_reason"], "tool_calls")

    def test_incomplete_or_unknown_calls_fail_closed(self):
        for text in ['<tool_call>{"name":"lookup","arguments":{}', '<tool_call>{"name":"unknown","arguments":{}}</tool_call>']:
            with self.assertRaises(ValueError):
                self.generate(text)

    def test_ssm_template_receives_tool_call_and_result_as_text(self):
        tokenizer = Tokenizer()
        tokenizer.has_tool_calling = False
        messages = [{"role": "assistant", "content": None, "tool_calls": [{"function": {"name": "lookup", "arguments": '{"q":"Paris"}'}}]},
                    {"role": "tool", "content": "Paris is the capital.", "tool_call_id": "call-1"}]
        self.generate("Paris.", tokenizer, messages)
        self.assertIn("<tool_call>", tokenizer.messages[1]["content"])
        self.assertEqual(tokenizer.messages[2]["role"], "user")
        self.assertIn("call-1", tokenizer.messages[2]["content"])
        self.assertIn("Paris is the capital", tokenizer.messages[2]["content"])


if __name__ == "__main__":
    unittest.main()
