use crate::security::*;
use serde_json::Value;
pub fn identifier(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
pub fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}
/// Use PostgreSQL's actual AST, not a SELECT-prefix check. Native libpg_query replaces its WASM build.
pub fn select_sql(input: &str) -> Result<String> {
    if input.trim().is_empty() || input.len() > 50_000 {
        return Err(Error::new(
            "INVALID_SQL",
            "SQL must contain 1..50000 UTF-8 bytes",
            400,
        ));
    }
    let parsed = pg_query::parse(input)
        .map_err(|_| Error::new("INVALID_SQL", "Invalid PostgreSQL syntax", 400))?;
    if parsed.protobuf.stmts.len() != 1
        || !matches!(
            parsed.protobuf.stmts[0]
                .stmt
                .as_ref()
                .and_then(|s| s.node.as_ref()),
            Some(pg_query::NodeEnum::SelectStmt(_))
        )
    {
        return Err(Error::new(
            "SELECT_ONLY",
            "Exactly one SELECT or read-only WITH SELECT is allowed",
            400,
        ));
    }
    let tree = serde_json::to_value(&parsed.protobuf).map_err(|_| invalid())?;
    let mut stack = vec![&tree];
    while let Some(v) = stack.pop() {
        match v {
            Value::Array(a) => stack.extend(a),
            Value::Object(o) => {
                for (key, value) in o {
                    if (key.ends_with("Stmt") && key != "SelectStmt")
                        || (key == "into_clause" && !value.is_null())
                        || (key == "locking_clause"
                            && value.as_array().is_some_and(|a| !a.is_empty()))
                    {
                        return Err(Error::new(
                            "SELECT_ONLY",
                            "Writes, SELECT INTO and locking clauses are not allowed",
                            400,
                        ));
                    }
                    if key == "FuncCall" {
                        let name = value["funcname"]
                            .as_array()
                            .and_then(|a| a.last())
                            .and_then(|n| n["node"]["String"]["sval"].as_str())
                            .unwrap_or("")
                            .to_lowercase();
                        if ["set_config", "setval", "nextval"].contains(&name.as_str())
                            || name.starts_with("pg_")
                            || name.starts_with("dblink")
                        {
                            return Err(Error::new(
                                "UNSAFE_FUNCTION",
                                "Session, sequence and administrative functions are not allowed",
                                400,
                            ));
                        }
                    }
                    stack.push(value);
                }
            }
            _ => (),
        }
    }
    let sql = pg_query::deparse(&parsed.protobuf).map_err(|_| invalid())?;
    Ok(sql.trim().trim_end_matches(';').to_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_sql_policy() {
        // Test-only repository fixture: no validation or management HTTP route.
        let policy: Value = serde_json::from_str(include_str!(
            "../../../../repos/emap-postgis-plugin/test/fixtures/sql-policy.json"
        ))
        .unwrap();
        for case in policy["cases"].as_array().unwrap() {
            let sql = case["sql"].as_str().unwrap();
            let result = select_sql(sql);
            if let Some(code) = case["error"].as_str() {
                assert_eq!(result.unwrap_err().code, code, "{}", case["name"]);
            } else {
                let normalized = result.unwrap_or_else(|e| panic!("{}: {e:?}", case["name"]));
                assert!(!normalized.ends_with(';'), "{}", case["name"]);
            }
        }
    }
    #[test]
    fn limits_utf8_bytes() {
        let sql = format!("SELECT '{}'", "中".repeat(17000));
        assert_eq!(select_sql(&sql).unwrap_err().code, "INVALID_SQL");
    }
    #[test]
    fn safe_identifier_and_literal() {
        assert_eq!(identifier("a\"b"), "\"a\"\"b\"");
        assert_eq!(literal("a'b"), "'a''b'");
    }
}
