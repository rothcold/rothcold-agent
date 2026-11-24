def register(ctx):
    from .adapter import RothcoldAgent, env_enablement, ready, standalone_send

    ctx.register_platform(
        name="rothcold_agent", label="Rothcold Agent", adapter_factory=RothcoldAgent,
        check_fn=ready, validate_config=lambda config: ready(),
        required_env=["ROTHCOLD_AGENT_ADAPTER_TOKEN", "ROTHCOLD_AGENT_ALLOWED_USERS"],
        env_enablement_fn=env_enablement,
        cron_deliver_env_var="ROTHCOLD_AGENT_HOME_CHANNEL",
        standalone_sender_fn=standalone_send,
        allowed_users_env="ROTHCOLD_AGENT_ALLOWED_USERS",
        display_tier="high",
        display_overrides={"streaming": False},
        max_message_length=65536,
        platform_hint=(
            "You are chatting via Rothcold Agent. Standard Markdown renders (headings, bold, italic, "
            "strikethrough, lists, blockquotes, tables, inline code, fenced code blocks, and http/https links). "
            "There is no native file or media attachment channel: state absolute file paths in text instead of MEDIA: tags."
        ),
    )
