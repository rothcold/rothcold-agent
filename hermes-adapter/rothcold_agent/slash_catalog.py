import re

_SLUG = re.compile(r'[a-z0-9_-]{1,64}')
_COMMAND_LIMIT = 128
_SKILL_LIMIT = 256


def _bounded_names(names, limit):
    return sorted({name for name in names if _SLUG.fullmatch(name)})[:limit]


def gateway_slash_catalog(platform, extra, owner):
    # Match the pinned Gateway /commands directory and the inbound platform skill filter.
    from agent.skill_commands import get_skill_commands
    from agent.skill_utils import get_disabled_skill_names
    from gateway.slash_access import policy_for_chat_type
    from hermes_cli.commands import (
        COMMAND_REGISTRY,
        _is_gateway_available,
        _resolve_config_gates,
    )

    policy = policy_for_chat_type(extra, 'dm')
    gates = _resolve_config_gates()
    commands = _bounded_names((cmd.name for cmd in COMMAND_REGISTRY
                               if _is_gateway_available(cmd, gates) and policy.can_run(owner, cmd.name)),
                              _COMMAND_LIMIT)
    disabled = get_disabled_skill_names(platform=platform)
    skills = _bounded_names((key.removeprefix('/') for key, meta in get_skill_commands().items()
                             if policy.is_admin(owner) and meta['name'] not in disabled), _SKILL_LIMIT)
    return {'commands': commands, 'skills': skills}
