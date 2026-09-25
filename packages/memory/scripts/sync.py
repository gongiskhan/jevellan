"""Run the pinned provider's foreground project sync in Jevellan's environment."""
import json
import os
import sys
from pathlib import Path

if not os.environ.get("BASIC_MEMORY_CONFIG_DIR") or os.environ.get("BASIC_MEMORY_FORCE_LOCAL") != "true" or os.environ.get("BASIC_MEMORY_EXPLICIT_ROUTING") != "true":
    raise RuntimeError("Project sync requires an isolated local configuration.")

# The parent supplies the isolated environment before this provider is imported.
from basic_memory.config import ConfigManager
from basic_memory.cli.commands.command_utils import run_with_cleanup
from basic_memory.mcp.async_client import get_client
from basic_memory.mcp.clients import ProjectClient
from basic_memory.mcp.project_context import get_active_project
from basic_memory.utils import generate_permalink

request = json.load(sys.stdin)
if set(request) != {"schema", "project", "path"} or request["schema"] != "memory-sync-request-v1":
    raise ValueError("Invalid project sync request.")
name = request["project"]
config = ConfigManager().config
entry = config.projects.get(name) or config.projects.get(generate_permalink(name))
if entry is None or Path(entry.path).resolve() != Path(request["path"]).resolve():
    raise ValueError("Project sync path does not match the registered project.")
if config.auto_update or config.sync_changes or config.ensure_frontmatter_on_sync or not config.disable_permalinks:
    raise ValueError("Project sync requires controlled updates and unchanged note files.")


async def sync():
    async with get_client(project_name=name) as client:
        project = await get_active_project(client, name, None)
        if project.name != name:
            raise ValueError("Project sync resolved another project.")
        result = await ProjectClient(client).sync(project.external_id, force_full=True, run_in_background=False)
        print(json.dumps({"schema": "memory-sync-v1", "project": name, "total": result["total"]}))


run_with_cleanup(sync())
