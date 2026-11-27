use crate::{App, BAD, Input, Result, lock};
use axum::{Extension, Json, extract::State};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(30);
const NAME_LIMIT: usize = 64;
const COMMAND_LIMIT: usize = 128;
const SKILL_LIMIT: usize = 256;

#[derive(Default)]
pub struct SlashCatalog(Option<(Instant, Value)>);

fn names(value: &Value, limit: usize) -> Result<Vec<&str>> {
    let items = value
        .as_array()
        .filter(|items| items.len() <= limit)
        .ok_or(BAD)?;
    let mut names = Vec::with_capacity(items.len());
    for item in items {
        let name = item
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= NAME_LIMIT
                    && s.bytes().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_')
                    })
            })
            .ok_or(BAD)?;
        names.push(name);
    }
    names.sort_unstable();
    names.dedup();
    Ok(names)
}

impl SlashCatalog {
    fn publish(&mut self, input: &Value, now: Instant) -> Result<()> {
        let catalog = input.get("catalog").ok_or(BAD)?;
        self.0 = if catalog.is_null() {
            None
        } else {
            let commands = names(&catalog["commands"], COMMAND_LIMIT)?;
            let mut skills = names(&catalog["skills"], SKILL_LIMIT)?;
            skills.retain(|name| commands.binary_search(name).is_err());
            Some((now, json!({"commands": commands, "skills": skills})))
        };
        Ok(())
    }

    fn response(&self, now: Instant) -> Value {
        let catalog = self
            .0
            .as_ref()
            .filter(|(at, _)| now.duration_since(*at) < TTL);
        json!({"catalog": catalog.map(|(_, value)| value)})
    }
}

pub async fn get(State(app): State<App>) -> Json<Value> {
    let catalog = lock(&app.slash_catalog);
    Json(catalog.response(Instant::now()))
}

pub async fn report(State(app): State<App>, Extension(input): Input) -> Result<Json<Value>> {
    let mut catalog = lock(&app.slash_catalog);
    catalog.publish(&input, Instant::now())?;
    Ok(Json(json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_catalog_is_names_only_bounded_and_expires() {
        let now = Instant::now();
        let mut state = SlashCatalog::default();
        assert_eq!(state.response(now), json!({"catalog": null}));
        state.publish(&json!({"catalog": {"commands": ["status", "help", "help"], "skills": ["status", "synthetic-skill"], "body": "not forwarded"}}), now).unwrap();
        let expected =
            json!({"catalog": {"commands": ["help", "status"], "skills": ["synthetic-skill"]}});
        assert_eq!(state.response(now), expected);
        for invalid in [
            json!({"catalog": {"commands": [], "skills": ["/private/skill"]}}),
            json!({"catalog": {"commands": [], "skills": ["s".repeat(NAME_LIMIT + 1)]}}),
            json!({"catalog": {"commands": vec!["status"; COMMAND_LIMIT + 1], "skills": []}}),
            json!({"catalog": {"commands": [], "skills": vec!["skill"; SKILL_LIMIT + 1]}}),
        ] {
            assert!(state.publish(&invalid, now).is_err());
            assert_eq!(state.response(now), expected);
        }
        assert_eq!(state.response(now + TTL), json!({"catalog": null}));
        state.publish(&json!({"catalog": null}), now).unwrap();
        assert_eq!(state.response(now), json!({"catalog": null}));
    }
}
