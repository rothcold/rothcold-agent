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
    pub fn card(&self, chat: &str, id: &str) -> Option<&Card> {
        if !self.live() || self.decisions.iter().any(|(c, i, _)| c == chat && i == id) {
            return None;
        }
        self.cards.iter().find(|c| c.chat == chat && c.id == id)
    }
    #[cfg(test)]
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
        self.answer_choice(chat, id, choice)
    }
    pub fn answer_choice(&mut self, chat: &str, id: &str, choice: &str) -> Result<()> {
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
    fn decisions_cannot_cross_requests_or_survive_lost_contact() -> Result<()> {
        let mut mailbox = Mailbox::default();
        let poll = |id| json!({"approvals":[{"id":id,"chat":"thread","choices":["once","deny"]}]});
        mailbox.poll(&poll("first"))?;
        assert!(
            mailbox
                .answer("thread", "first", "/approve session")
                .is_err()
        );
        mailbox.answer("thread", "first", "/approve")?;
        assert!(mailbox.poll(&poll("second"))?.is_none());
        assert!(mailbox.answer("thread", "first", "/approve").is_err());
        mailbox.answer("thread", "second", "/deny")?;
        mailbox.last_poll = Some(Instant::now() - Duration::from_secs(6));
        assert!(mailbox.poll(&poll("second"))?.is_none());
        mailbox.answer("thread", "second", "/deny")?;
        assert_eq!(
            mailbox.poll(&poll("second"))?.ok_or(crate::Error(
                S::INTERNAL_SERVER_ERROR,
                "pending decision was not delivered"
            ))?["choice"],
            "deny"
        );
        assert!(mailbox.answer("thread", "second", "/deny").is_err());
        Ok(())
    }
}
