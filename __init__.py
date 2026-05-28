from .preset_loader import PresetLoaderNode

NODE_CLASS_MAPPINGS = {
    "PresetLoader": PresetLoaderNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PresetLoader": "Preset Loader 📋",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]