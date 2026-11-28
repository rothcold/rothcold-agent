use super::Result;
#[cfg(test)]
use super::rows;
use pulldown_cmark::{Event, Options, Parser, TagEnd};
use rusqlite::{Connection, params};
#[cfg(test)]
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

const PREVIEW_GRAPHEMES: usize = 140;
// A single grapheme can contain arbitrarily many combining marks.
const PREVIEW_BYTES: usize = 4096;

fn preview(markdown: &str) -> String {
    let mut visible = String::new();
    let options = Options::ENABLE_GFM
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS;
    for event in Parser::new_ext(markdown, options) {
        match event {
            Event::Text(text) | Event::Code(text) | Event::Html(text) | Event::InlineHtml(text) => {
                visible.push_str(&text);
            }
            Event::SoftBreak
            | Event::HardBreak
            | Event::Rule
            | Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::BlockQuote(_)
                | TagEnd::CodeBlock
                | TagEnd::Item
                | TagEnd::TableCell
                | TagEnd::TableRow,
            ) => visible.push(' '),
            _ => (),
        }
    }
    let text = visible.split_whitespace().collect::<Vec<_>>().join(" ");
    let end = text
        .grapheme_indices(true)
        .nth(PREVIEW_GRAPHEMES)
        .map_or(text.len(), |(index, _)| index);
    if end == text.len() && end <= PREVIEW_BYTES {
        return text;
    }
    let budget = PREVIEW_BYTES - '…'.len_utf8();
    let end = if end > budget {
        text.grapheme_indices(true)
            .take_while(|(index, _)| *index <= budget)
            .last()
            .map_or(0, |(index, _)| index)
    } else {
        end
    };
    format!("{}…", &text[..end])
}

pub(super) fn backfill_previews(db: &Connection) -> Result<()> {
    // Walk the turns, not the table being updated. Do not insert or mark notifications.
    let mut query = db.prepare("SELECT id,answer FROM turns WHERE id IN (SELECT request FROM notifications) AND answer IS NOT NULL")?;
    let mut old = query.query([])?;
    let mut update = db.prepare("UPDATE notifications SET preview=? WHERE request=?")?;
    while let Some(turn) = old.next()? {
        let id: String = turn.get(0)?;
        let answer: String = turn.get(1)?;
        update.execute(params![preview(&answer), id])?;
    }
    Ok(())
}

pub(super) fn record(db: &Connection, id: &str, text: &str) -> Result<()> {
    db.execute(
        "INSERT INTO notifications(request,preview) VALUES (?,?)",
        params![id, preview(text)],
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn notifications(db: &Connection) -> Result<Value> {
    Ok(rows(db,"SELECT request,turns.chat,placement.channel,unread,chats.title,notifications.preview FROM notifications JOIN turns ON turns.id=request JOIN chats ON chats.id=turns.chat JOIN placement ON placement.chat=turns.chat ORDER BY notifications.rowid DESC",[])?.into())
}

#[cfg(test)]
mod tests {
    use super::{PREVIEW_BYTES, preview};

    #[test]
    fn preview_flattens_markdown_without_link_targets_or_block_syntax() {
        assert_eq!(
            preview(
                "# 标题\n\n> **粗体** [说明](https://example.invalid/private)\n> 第二行\n\n- ~~旧~~\n- `x  y`\n\n~~~rust\nlet value = 3;\n~~~\n\n|甲|乙|\n|-|-|\n|丙|丁|"
            ),
            "标题 粗体 说明 第二行 旧 x y let value = 3; 甲 乙 丙 丁"
        );
    }

    #[test]
    fn preview_keeps_extended_graphemes_and_only_marks_truncation() {
        let prefix = "云".repeat(138);
        let exact = format!("{prefix}e\u{301}👩🏽‍🚀");
        assert_eq!(preview(&exact), exact);
        assert_eq!(preview(&format!("{exact}🇭🇰")), format!("{exact}…"));
        let oversized = format!("a{}", "\u{301}".repeat(PREVIEW_BYTES));
        assert_eq!(preview(&oversized), "…");
    }
}
