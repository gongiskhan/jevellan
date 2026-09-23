"""Inspect the installed package with all data routed into a temporary directory."""
import importlib.metadata
import json
import os
import tempfile

with tempfile.TemporaryDirectory(prefix="jevellan-memory-spike-") as directory:
    os.environ["BASIC_MEMORY_CONFIG_DIR"] = directory
    os.environ["BASIC_MEMORY_MCP_PROJECT"] = "jv-project-a"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    from basic_memory.config import resolve_data_dir
    from basic_memory.project_resolver import ProjectResolver

    resolver = ProjectResolver.from_env(default_project="other")
    result = {
        "schema": "memory-spike-v1",
        "evidence": "installed-package-isolated-probe",
        "version": importlib.metadata.version("basic-memory"),
        "configDirectoryIsolated": str(resolve_data_dir()) == directory,
        "projectConstraintOverridesExplicitProject": resolver.resolve(project="jv-project-b").project == "jv-project-a",
        "projectConstraintOverridesDiscovery": resolver.resolve(allow_discovery=True).project == "jv-project-a",
    }
    print(json.dumps(result, indent=2))
    assert all(value for key, value in result.items() if key not in {"schema", "evidence", "version"})
