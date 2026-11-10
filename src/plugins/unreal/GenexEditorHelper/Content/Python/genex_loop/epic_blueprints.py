"""Epic's Python Blueprint tools, which a part's Blueprint text is written and checked with: Unreal
5.8's `BlueprintTools` and its private memory of each graph's node types. Unreal 5.9 moved them to
C++ and writes Blueprint text with another toolset, so there a tool that needs them says so."""

from genex_loop.errors import Refused

NOT_HERE = ("This Unreal has no Python BlueprintTools: from Unreal 5.9, Blueprints are written with "
            "Epic's BlueprintToolsets.BlueprintDslToolset (read its Docs, then Write or Edit) and edited "
            "with BlueprintToolsets.BlueprintToolset, so a part's Blueprint text can't be applied or "
            "checked here.")


def tools():
    """Epic's BlueprintTools; Refused on an Unreal that no longer has them."""
    try:
        from editor_toolset.toolsets.blueprint import BlueprintTools
    except ImportError as error:
        raise Refused(NOT_HERE) from error
    return BlueprintTools


def node_cache():
    """Epic's private memory of each graph's node types; Refused on an Unreal that no longer has it."""
    try:
        from editor_toolset.toolsets.blueprint import _BlueprintCache
    except ImportError as error:
        raise Refused(NOT_HERE) from error
    return _BlueprintCache
