//! Live owner decisions, never durable user turns. The adapter advertises only pending Hermes cards.
use super::{BAD, Error, Result, S};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
pub struct Card {
    pub chat: String,
    pub id: String,
    pub choices: Vec<String>,
}
#[derive(Default)]
pub struct Mailbox {
    cards: Vec<Card>,
    last_poll: Option<Instant>,
    decisions: Vec<(String, String, String)>,
}
const STALE: Error = Error(
    S::CONFLICT,
    "No matching live approval. Review the current prompt; nothing was approved.",
);
pub fn is_control(text: &str) -> bool {
    let name = text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split('@')
        .next()
        .unwrap_or("");
    name.eq_ignore_ascii_case("/approve") || name.eq_ignore_ascii_case("/deny")
}
impl Mailbox {
    pub fn poll(&mut self, input: &Value) -> Result<Option<Value>> {
        let cards: Vec<Card> = match input.get("approvals") {
            None => Vec::new(),
            Some(v) => serde_json::from_value(v.clone()).map_err(|_| BAD)?,
        };
        if !self.live() {
            self.decisions.clear();
        }
        self.cards = cards;
        self.last_poll = Some(Instant::now());
        while let Some((chat, id, choice)) = self.decisions.pop() {
            if let Some(i) = self
                .cards
                .iter()
                .position(|c| c.chat == chat && c.id == id && c.choices.contains(&choice))
            {
                self.cards.swap_remove(i);
                return Ok(Some(json!({"approval":id,"chat":chat,"choice":choice})));
            }
        }
        Ok(None)
    }
    fn live(&self) -> bool {
        self.last_poll
            .is_some_and(|t| t.elapsed() < Duration::from_secs(5))
    }
    fn card(&self, chat: &str, id: &str) -> Option<&Card> {
        if !self.live() || self.decisions.iter().any(|(c, i, _)| c == chat && i == id) {
            return None;
        }
        self.cards.iter().find(|c| c.chat == chat && c.id == id)
    }
    pub fn annotate(&self, chat: &str, history: &mut Value) {
        for t in history.as_array_mut().unwrap() {
            if matches!(t["state"].as_str(), Some("reserved" | "accepted")) {
                for u in t["updates"].as_array_mut().unwrap() {
                    if let Some(c) = self.card(chat, u["id"].as_str().unwrap()) {
                        u["choices"] = json!(c.choices);
                    }
                }
            }
        }
    }
    pub fn answer(&mut self, chat: &str, id: &str, text: &str) -> Result<()> {
        let normalized = text.to_ascii_lowercase();
        let args: Vec<_> = normalized.split_whitespace().collect();
        let choice = match args.as_slice() {
            ["/approve"] | ["/approve", "once"] => "once",
            ["/approve", "session"] => "session",
            ["/deny"] => "deny",
            _ => {
                return Err(Error(
                    S::BAD_REQUEST,
                    "Use /approve, /approve session or /deny on a live prompt.",
                ));
            }
        };
        if !self
            .card(chat, id)
            .is_some_and(|c| c.choices.iter().any(|v| v == choice))
        {
            return Err(STALE);
        }
        self.decisions.push((chat.into(), id.into(), choice.into()));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_cannot_cross_requests_or_survive_lost_contact() {
        let mut mailbox = Mailbox::default();
        let poll = |id| json!({"approvals":[{"id":id,"chat":"thread","choices":["once","deny"]}]});
        mailbox.poll(&poll("first")).unwrap();
        assert!(
            mailbox
                .answer("thread", "first", "/approve session")
                .is_err()
        );
        mailbox.answer("thread", "first", "/approve").unwrap();
        assert!(mailbox.poll(&poll("second")).unwrap().is_none());
        assert!(mailbox.answer("thread", "first", "/approve").is_err());
        mailbox.answer("thread", "second", "/deny").unwrap();
        mailbox.last_poll = Some(Instant::now() - Duration::from_secs(6));
        assert!(mailbox.poll(&poll("second")).unwrap().is_none());
        mailbox.answer("thread", "second", "/deny").unwrap();
        assert_eq!(
            mailbox.poll(&poll("second")).unwrap().unwrap()["choice"],
            "deny"
        );
        assert!(mailbox.answer("thread", "second", "/deny").is_err());
    }
}
