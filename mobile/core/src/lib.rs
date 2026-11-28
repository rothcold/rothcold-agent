mod noise;

uniffi::setup_scaffolding!();

#[derive(uniffi::Record)]
pub struct DirectoryCategory {
    pub id: String,
    pub name: String,
    pub archived: bool,
}

#[derive(uniffi::Record)]
pub struct DirectoryThread {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub archived: bool,
}

#[derive(uniffi::Record, Debug, PartialEq)]
pub struct ActiveCategory {
    pub id: String,
    pub name: String,
    pub threads: Vec<ThreadSummary>,
}

#[derive(uniffi::Record, Debug, PartialEq)]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
}

/// Preserve server order; a thread is effectively archived if it or its category is archived.
#[uniffi::export]
pub fn active_directory(
    categories: Vec<DirectoryCategory>,
    threads: Vec<DirectoryThread>,
) -> Vec<ActiveCategory> {
    let mut groups: std::collections::HashMap<String, Vec<ThreadSummary>> = Default::default();
    for thread in threads.into_iter().filter(|thread| !thread.archived) {
        groups
            .entry(thread.channel)
            .or_default()
            .push(ThreadSummary {
                id: thread.id,
                title: thread.title,
            });
    }
    categories
        .into_iter()
        .filter(|category| !category.archived)
        .map(|category| ActiveCategory {
            threads: groups.remove(&category.id).unwrap_or_default(),
            id: category.id,
            name: category.name,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_directory_preserves_order_and_hides_effective_archives() {
        let categories =
            [("general", false), ("archive", true), ("empty", false)].map(|(id, archived)| {
                DirectoryCategory {
                    id: id.into(),
                    name: id.into(),
                    archived,
                }
            });
        let threads = [
            ("new", "general", false),
            ("hidden", "general", true),
            ("parent-hidden", "archive", false),
            ("old", "general", false),
        ]
        .map(|(id, channel, archived)| DirectoryThread {
            id: id.into(),
            title: id.into(),
            channel: channel.into(),
            archived,
        });
        let active = active_directory(Vec::from(categories), Vec::from(threads));
        assert_eq!(
            active.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["general", "empty"]
        );
        assert_eq!(
            active[0]
                .threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["new", "old"]
        );
        assert!(active[1].threads.is_empty());
    }
}
