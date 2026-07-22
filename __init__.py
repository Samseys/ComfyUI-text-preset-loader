from .preset_loader import PresetLoaderNode, register_routes

# Binding the HTTP routes is an explicit step rather than an import side effect,
# so preset_loader/-_model/-_storage stay importable without a live PromptServer.
register_routes()

NODE_CLASS_MAPPINGS = {
    "PresetLoader": PresetLoaderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PresetLoader": "Preset Loader 📋",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]