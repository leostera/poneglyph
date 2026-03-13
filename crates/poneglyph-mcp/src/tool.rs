use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallToolResult {
    pub content: Value,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{CallToolResult, Tool, ToolCall};

    #[test]
    fn tool_call_defaults_arguments_to_null() {
        let call: ToolCall = serde_json::from_value(json!({
            "name": "Poneglyph-query"
        }))
        .expect("tool call");

        assert_eq!(call.arguments, serde_json::Value::Null);
    }

    #[test]
    fn tool_round_trips_through_json() {
        let tool = Tool {
            name: "Poneglyph-search".to_string(),
            description: "Search entities.".to_string(),
            input_schema: json!({"type": "object"}),
        };

        let encoded = serde_json::to_value(&tool).expect("encode");
        let decoded: Tool = serde_json::from_value(encoded).expect("decode");

        assert_eq!(decoded, tool);
    }

    #[test]
    fn call_tool_result_round_trips() {
        let result = CallToolResult {
            content: json!({"txId": "poneglyph:tx:123"}),
        };

        let encoded = serde_json::to_value(&result).expect("encode");
        let decoded: CallToolResult = serde_json::from_value(encoded).expect("decode");

        assert_eq!(decoded, result);
    }
}
