# Feedback For `agents` Crate

This came out of wiring `poneglyph-agent` to OpenAI function tools.

## 1. OpenAI-safe schema generation should be a first-class path

Right now the crate accepts arbitrary `serde_json::Value` tool schemas, which is flexible, but it leaves every caller to rediscover OpenAI's validator quirks on their own.

What would help:

- a built-in `openai_function_schema_for::<T>()` helper built on `JsonSchema`
- sane schema transforms for OpenAI function tools
- an explicit "OpenAI-compatible subset" mode for typed tools

Concretely, we tripped over:

- `oneOf` being rejected
- nested schemas missing explicit `type`
- general "invalid_function_parameters" errors that were hard to localize

## 2. Better visibility into the exact tool schema sent to the provider

Debugging this was slower than it should have been because there was no obvious "show me the exact JSON sent to OpenAI for this tool" path.

What would help:

- a debug helper to dump the final tool payload before the provider call
- a way to print one tool definition by name
- optional structured logging around provider payload assembly

## 3. Provider-specific validation before network calls

It would be useful to fail locally before hitting OpenAI.

What would help:

- `ToolSet::validate_for_openai()` or equivalent
- validation errors that point to the exact tool name and JSON pointer path
- tests/helpers that assert a toolset is provider-compatible

## 4. A schema transform hook at the typed-tool boundary

We wanted to keep deriving schemas with `JsonSchema`, but still needed a final cleanup pass for provider compatibility.

What would help:

- a typed-tool hook like `fn transform_schema(schema: Value) -> Value`
- or a `ToolSet`-level transform pipeline

That keeps the source of truth in Rust types while still allowing provider-specific cleanup.

## 5. Stronger defaults for closed object schemas

OpenAI function tools behave better when object shapes are explicit and closed.

What would help:

- guidance or helpers that encourage `deny_unknown_fields`
- helpers that default object schemas to `additionalProperties: false`
- examples that show robust nested argument types, not just flat toy inputs

## 6. Tool ergonomics for complex values

The biggest pain point was a recursive `ValueInput` type for facts. Even though recursive/nested JSON Schema is valid in principle, provider compatibility can still be fragile.

What would help:

- docs showing recommended patterns for tool input types
- explicit guidance on what schema constructs are risky across providers
- examples for "structured but provider-safe" tool inputs

## 7. Error messages should carry more context

The provider returned errors like:

- `Invalid schema for function 'state_facts'`
- `In context=('properties', ...), schema must have a 'type' key`

What would help:

- preserving the provider's path while also printing the offending schema fragment
- surfacing the exact tool index and tool name consistently
- wrapping provider errors with actionable crate-level hints

## 8. Tool trace metadata should preserve the real tool name consistently

While running `evals`, the recorded tool trace stored our actual tool identifier in `id`, but `name` came through as `unknown_tool`, even for successful calls.

That made naive graders look like the agent never used the expected tool until we switched grading logic to check both fields.

What would help:

- guarantee that traced tool calls preserve the real tool name in one canonical field
- document whether `id` is meant to be the call id, the tool name, or both
- include a regression test around successful tool traces so eval authors can trust the recorded metadata

## 9. Recovery after tool errors needs stronger support

With smaller models, a failed tool call often led to the model emitting a fake JSON blob like `{\"name\": \"get_schema\", ...}` in assistant text instead of making a second real tool call.

What would help:

- a built-in retry / recovery strategy after tool errors
- optional provider-side tool-choice nudging after a tool failure
- examples showing how to keep the model in tool-calling mode after a bad first attempt

## Short version

The crate is close, but typed tools need a better provider-compatibility story:

- derive schema from Rust types
- transform it for a provider safely
- validate it locally
- inspect the exact emitted payload easily
- preserve trustworthy tool trace metadata
- make post-error tool recovery more reliable

That would have turned this debugging session from "trial and error against OpenAI" into a straightforward local fix.
