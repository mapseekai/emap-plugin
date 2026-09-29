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
    fn accepts_postgresql_selects() {
        for s in [
            "SELECT 1 AS id",
            "/*comment*/SELECT $1::text AS name;",
            "SELECT 'delete; drop table roads' AS label",
            "WITH x AS (SELECT 1 id) SELECT * FROM x",
            "SELECT a.id FROM roads a JOIN names b ON a.id=b.id WHERE b.name=$1",
            "SELECT ST_Intersects(geom,ST_MakeEnvelope(1,2,3,4,4326)) FROM roads",
            "SELECT 1 UNION ALL SELECT 2",
        ] {
            assert!(select_sql(s).is_ok(), "{s}: {:?}", select_sql(s));
        }
    }
    #[test]
    fn rejects_writes_and_side_effect_functions() {
        for s in [
            "SELECT 1; SELECT 2",
            "DELETE FROM roads",
            "DROP TABLE roads",
            "COPY roads TO STDOUT",
            "EXPLAIN SELECT 1",
            "SELECT * INTO copy FROM roads",
            "SELECT * FROM roads FOR UPDATE",
            "WITH changed AS (DELETE FROM roads RETURNING *) SELECT * FROM changed",
            "SELECT set_config('transaction_read_only','off',true)",
            "SELECT pg_catalog.set_config('search_path','evil',false)",
            "SELECT nextval('seq')",
            "SELECT dblink('x','SELECT 1')",
            "SELECT pg_sleep(1)",
            "",
        ] {
            assert!(select_sql(s).is_err(), "{s}");
        }
    }
    #[test]
    fn safe_identifier_and_literal() {
        assert_eq!(identifier("a\"b"), "\"a\"\"b\"");
        assert_eq!(literal("a'b"), "'a''b'");
    }
}
