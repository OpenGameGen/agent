# Adapted from Vollkorn-Games/godot-mcp, commit 632530638448ea3e79394fbf74e9a5c92c4b67e5.
# Copyright (c) 2025 Solomon Elias. MIT license: VOLLKORN_LICENSE.txt.
# Selected native editing functions; source mapping and changes: vollkorn-source.json.
extends RefCounted

var debug_mode = false
var errors: Array[String] = []
var messages: Array[String] = []
var allocations: Array[Node] = []
var committed = false

func _fresh(path: String) -> Resource:
    return ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE_DEEP)

func _track(value):
    if value is Node:
        allocations.append(value)
    return value

func _fail(message) -> void:
    errors.append(str(message))

func _report(message) -> void:
    messages.append(str(message))

func log_debug(message) -> void:
    if debug_mode:
        _report(message)

func _save_resource(resource: Resource, path: String) -> int:
    var result = ResourceSaver.save(resource, path)
    if result == OK:
        committed = true
    return result

func cleanup() -> void:
    for node in allocations:
        if is_instance_valid(node):
            node.free()
    allocations.clear()

func execute(operation: String, params: Dictionary) -> Dictionary:
    errors.clear()
    messages.clear()
    committed = false
    call(operation, params)
    var result: Dictionary
    if not errors.is_empty():
        result = {"error": "; ".join(errors)}
    elif operation in ["get_scene_tree", "get_node_properties", "get_tile_data"]:
        var data = JSON.parse_string(messages.back()) if not messages.is_empty() else null
        result = {"data": data} if data != null else {"error": "Native operation returned no readable result"}
    elif committed:
        result = {"path": params.get("scene_path", params.get("resource_path", "")), "saved": true}
    else:
        result = {"error": "Native operation did not save a result; inspect files before retrying"}
    cleanup()
    return result

func get_script_by_name(name_of_class):
    if debug_mode:
        _report("Attempting to get script for class: " + name_of_class)

    # Try to load it directly if it's a resource path
    if ResourceLoader.exists(name_of_class, "Script"):
        if debug_mode:
            _report("Resource exists, loading directly: " + name_of_class)
        var script = _fresh(name_of_class) as Script
        if script:
            if debug_mode:
                _report("Successfully loaded script from path")
            return script
        else:
            _fail("Failed to load script from path: " + name_of_class)
    elif debug_mode:
        _report("Resource not found, checking global class registry")

    # Search for it in the global class registry if it's a class name
    var global_classes = ProjectSettings.get_global_class_list()
    if debug_mode:
        _report("Searching through " + str(global_classes.size()) + " global classes")

    for global_class in global_classes:
        var found_name_of_class = global_class["class"]
        var found_path = global_class["path"]

        if found_name_of_class == name_of_class:
            if debug_mode:
                _report("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script = _fresh(found_path) as Script
            if script:
                if debug_mode:
                    _report("Successfully loaded script from registry")
                return script
            else:
                _fail("Failed to load script from registry path: " + found_path)
                break

    _fail("Could not find script for class: " + name_of_class)
    return null

func instantiate_class(name_of_class):
    if name_of_class.is_empty():
        _fail("Cannot instantiate class: name is empty")
        return null

    var result = null
    if debug_mode:
        _report("Attempting to instantiate class: " + name_of_class)

    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            _report("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = _track(ClassDB.instantiate(name_of_class))
            if result == null:
                _fail("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            _fail("Class exists but cannot be instantiated: " + name_of_class)
            _fail("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            _report("Class not found in ClassDB, trying to get script")
        var script = get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                _report("Found GDScript, creating instance")
            result = _track(script.new())
        else:
            _fail("Failed to get script for class: " + name_of_class)
            return null

    if result == null:
        _fail("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        _report("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())

    return result

func create_scene(params):
    _report("Creating scene: " + params.scene_path)

    # Get project paths and log them for debugging
    var project_res_path = "res://"
    var project_user_path = "user://"
    var global_res_path = ProjectSettings.globalize_path(project_res_path)
    var global_user_path = ProjectSettings.globalize_path(project_user_path)

    if debug_mode:
        _report("Project paths:")
        _report("- res:// path: " + project_res_path)
        _report("- user:// path: " + project_user_path)
        _report("- Globalized res:// path: " + global_res_path)
        _report("- Globalized user:// path: " + global_user_path)

        # Print some common environment variables for debugging
        _report("Environment variables:")
        var env_vars = ["PATH", "HOME", "USER", "TEMP", "GODOT_PATH"]
        for env_var in env_vars:
            if OS.has_environment(env_var):
                _report("  " + env_var + " = " + OS.get_environment(env_var))

    # Normalize the scene path
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        _report("Scene path (with res://): " + full_scene_path)

    # Convert resource path to an absolute path
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        _report("Absolute scene path: " + absolute_scene_path)

    # Get the scene directory paths
    var scene_dir_res = full_scene_path.get_base_dir()
    var scene_dir_abs = absolute_scene_path.get_base_dir()
    if debug_mode:
        _report("Scene directory (resource path): " + scene_dir_res)
        _report("Scene directory (absolute path): " + scene_dir_abs)

    # Only do extensive testing in debug mode
    if debug_mode:
        # Try to create a simple test file in the project root to verify write access
        var initial_test_file_path = "res://godot_mcp_test_write.tmp"
        var initial_test_file = FileAccess.open(initial_test_file_path, FileAccess.WRITE)
        if initial_test_file:
            initial_test_file.store_string("Test write access")
            initial_test_file.close()
            _report("Successfully wrote test file to project root: " + initial_test_file_path)

            # Verify the test file exists
            var initial_test_file_exists = FileAccess.file_exists(initial_test_file_path)
            _report("Test file exists check: " + str(initial_test_file_exists))

            # Clean up the test file
            if initial_test_file_exists:
                var remove_error = DirAccess.remove_absolute(ProjectSettings.globalize_path(initial_test_file_path))
                _report("Test file removal result: " + str(remove_error))
        else:
            var write_error = FileAccess.get_open_error()
            _fail("Failed to write test file to project root: " + str(write_error))
            _fail("This indicates a serious permission issue with the project directory")

    # Use traditional if-else statement for better compatibility
    var root_node_type = "Node2D"  # Default value
    if params.has("root_node_type"):
        root_node_type = params.root_node_type
    if debug_mode:
        _report("Root node type: " + root_node_type)

    # Create the root node
    var scene_root = instantiate_class(root_node_type)
    if not scene_root:
        _fail("Failed to instantiate node of type: " + root_node_type)
        _fail("Make sure the class exists and can be instantiated")
        _fail("Check if the class is registered in ClassDB or available as a script")
        return

    scene_root.name = "root"
    if debug_mode:
        _report("Root node created with name: " + scene_root.name)

    # The root stays unowned; the PackedScene owns its descendants.
    # A scene root has no owner; children are owned by this root.

    # Pack the scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        _report("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        # Only do extensive testing in debug mode
        if debug_mode:
            # First, let's verify we can write to the project directory
            _report("Testing write access to project directory...")
            var test_write_path = "res://test_write_access.tmp"
            var test_write_abs = ProjectSettings.globalize_path(test_write_path)
            var test_file = FileAccess.open(test_write_path, FileAccess.WRITE)

            if test_file:
                test_file.store_string("Write test")
                test_file.close()
                _report("Successfully wrote test file to project directory")

                # Clean up test file
                if FileAccess.file_exists(test_write_path):
                    var remove_error = DirAccess.remove_absolute(test_write_abs)
                    _report("Test file removal result: " + str(remove_error))
            else:
                var write_error = FileAccess.get_open_error()
                _fail("Failed to write test file to project directory: " + str(write_error))
                _fail("This may indicate permission issues with the project directory")
                # Continue anyway, as the scene directory might still be writable

        # Ensure the scene directory exists using DirAccess
        if debug_mode:
            _report("Ensuring scene directory exists...")

        # Get the scene directory relative to res://
        var scene_dir_relative = scene_dir_res.substr(6)  # Remove "res://" prefix
        if debug_mode:
            _report("Scene directory (relative to res://): " + scene_dir_relative)

        # Create the directory if needed
        if not scene_dir_relative.is_empty():
            # First check if it exists
            var dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
            if debug_mode:
                _report("Directory exists check (absolute): " + str(dir_exists))

            if not dir_exists:
                if debug_mode:
                    _report("Directory doesn't exist, creating: " + scene_dir_relative)

                # Try to create the directory using DirAccess
                var dir = DirAccess.open("res://")
                if dir == null:
                    var open_error = DirAccess.get_open_error()
                    _fail("Failed to open res:// directory: " + str(open_error))

                    # Try alternative approach with absolute path
                    if debug_mode:
                        _report("Trying alternative directory creation approach...")
                    var make_dir_error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
                    if debug_mode:
                        _report("Make directory result (absolute): " + str(make_dir_error))

                    if make_dir_error != OK:
                        _fail("Failed to create directory using absolute path")
                        _fail("Error code: " + str(make_dir_error))
                        return
                else:
                    # Create the directory using the DirAccess instance
                    if debug_mode:
                        _report("Creating directory using DirAccess: " + scene_dir_relative)
                    var make_dir_error = dir.make_dir_recursive(scene_dir_relative)
                    if debug_mode:
                        _report("Make directory result: " + str(make_dir_error))

                    if make_dir_error != OK:
                        _fail("Failed to create directory: " + scene_dir_relative)
                        _fail("Error code: " + str(make_dir_error))
                        return

                # Verify the directory was created
                dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
                if debug_mode:
                    _report("Directory exists check after creation: " + str(dir_exists))

                if not dir_exists:
                    _fail("Directory reported as created but does not exist: " + scene_dir_abs)
                    _fail("This may indicate a problem with path resolution or permissions")
                    return
            elif debug_mode:
                _report("Directory already exists: " + scene_dir_abs)

        # Save the scene
        if debug_mode:
            _report("Saving scene to: " + full_scene_path)
        var save_error = _save_resource(packed_scene, full_scene_path)
        if debug_mode:
            _report("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")

        if save_error == OK:
            # Only do extensive testing in debug mode
            if debug_mode:
                # Wait a moment to ensure file system has time to complete the write
                _report("Waiting for file system to complete write operation...")
                OS.delay_msec(500)  # 500ms delay

                # Verify the file was actually created using multiple methods
                var file_check_abs = FileAccess.file_exists(absolute_scene_path)
                _report("File exists check (absolute path): " + str(file_check_abs))

                var file_check_res = FileAccess.file_exists(full_scene_path)
                _report("File exists check (resource path): " + str(file_check_res))

                var res_exists = ResourceLoader.exists(full_scene_path)
                _report("Resource exists check: " + str(res_exists))

                # If file doesn't exist by absolute path, try to create a test file in the same directory
                if not file_check_abs and not file_check_res:
                    _fail("Scene file not found after save. Trying to diagnose the issue...")

                    # Try to write a test file to the same directory
                    var test_scene_file_path = scene_dir_res + "/test_scene_file.tmp"
                    var test_scene_file = FileAccess.open(test_scene_file_path, FileAccess.WRITE)

                    if test_scene_file:
                        test_scene_file.store_string("Test scene directory write")
                        test_scene_file.close()
                        _report("Successfully wrote test file to scene directory: " + test_scene_file_path)

                        # Check if the test file exists
                        var test_file_exists = FileAccess.file_exists(test_scene_file_path)
                        _report("Test file exists: " + str(test_file_exists))

                        if test_file_exists:
                            # Directory is writable, so the issue is with scene saving
                            _fail("Directory is writable but scene file wasn't created.")
                            _fail("This suggests an issue with _save_resource() or the packed scene.")

                            # Try saving with a different approach
                            _report("Trying alternative save approach...")
                            var alt_save_error = _save_resource(packed_scene, test_scene_file_path + ".tscn")
                            _report("Alternative save result: " + str(alt_save_error))

                            # Clean up test files
                            DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path))
                            if alt_save_error == OK:
                                DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path + ".tscn"))
                        else:
                            _fail("Test file couldn't be verified. This suggests filesystem access issues.")
                    else:
                        var write_error = FileAccess.get_open_error()
                        _fail("Failed to write test file to scene directory: " + str(write_error))
                        _fail("This confirms there are permission or path issues with the scene directory.")

                    # Return error since we couldn't create the scene file
                    _fail("Failed to create scene: " + params.scene_path)
                    return

                # If we get here, at least one of our file checks passed
                if file_check_abs or file_check_res or res_exists:
                    _report("Scene file verified to exist!")

                    # Try to load the scene to verify it's valid
                    var test_load = ResourceLoader.load(full_scene_path)
                    if test_load:
                        _report("Scene created and verified successfully at: " + params.scene_path)
                        _report("Scene file can be loaded correctly.")
                    else:
                        _report("Scene file exists but cannot be loaded. It may be corrupted or incomplete.")
                        # Continue anyway since the file exists

                    _report("Scene created successfully at: " + params.scene_path)
                else:
                    _fail("All file existence checks failed despite successful save operation.")
                    _fail("This indicates a serious issue with file system access or path resolution.")
                    return
            else:
                # In non-debug mode, just check if the file exists
                var file_exists = FileAccess.file_exists(full_scene_path)
                if file_exists:
                    _report("Scene created successfully at: " + params.scene_path)
                else:
                    _fail("Failed to create scene: " + params.scene_path)
                    return
        else:
            # Handle specific error codes
            var error_message = "Failed to save scene. Error code: " + str(save_error)

            if save_error == ERR_CANT_CREATE:
                error_message += " (ERR_CANT_CREATE - Cannot create the scene file)"
            elif save_error == ERR_CANT_OPEN:
                error_message += " (ERR_CANT_OPEN - Cannot open the scene file for writing)"
            elif save_error == ERR_FILE_CANT_WRITE:
                error_message += " (ERR_FILE_CANT_WRITE - Cannot write to the scene file)"
            elif save_error == ERR_FILE_NO_PERMISSION:
                error_message += " (ERR_FILE_NO_PERMISSION - No permission to write the scene file)"

            _fail(error_message)
            return
    else:
        _fail("Failed to pack scene: " + str(result))
        _fail("Error code: " + str(result))
        return

func add_node(params):
    _report("Adding node to scene: " + params.scene_path)

    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        _report("Scene path (with res://): " + full_scene_path)

    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        _report("Absolute scene path: " + absolute_scene_path)

    if not FileAccess.file_exists(absolute_scene_path):
        _fail("Scene file does not exist at: " + absolute_scene_path)
        return

    var scene = _fresh(full_scene_path)
    if not scene is PackedScene:
        _fail("Failed to load scene: " + full_scene_path)
        return

    if debug_mode:
        _report("Scene loaded successfully")
    var scene_root = _track(scene.instantiate())
    if debug_mode:
        _report("Scene instantiated")

    # Use traditional if-else statement for better compatibility
    var parent_path = "root"  # Default value
    if params.has("parent_node_path"):
        parent_path = params.parent_node_path
    if debug_mode:
        _report("Parent path: " + parent_path)

    var parent = scene_root
    if parent_path != "root":
        parent = scene_root.get_node_or_null(parent_path.replace("root/", ""))
        if not parent:
            _fail("Parent node not found: " + parent_path)
            return
    if debug_mode:
        _report("Parent node found: " + parent.name)

    if debug_mode:
        _report("Instantiating node of type: " + params.node_type)
    var new_node = instantiate_class(params.node_type)
    if not new_node:
        _fail("Failed to instantiate node of type: " + params.node_type)
        _fail("Make sure the class exists and can be instantiated")
        _fail("Check if the class is registered in ClassDB or available as a script")
        return
    new_node.name = params.node_name
    if debug_mode:
        _report("New node created with name: " + new_node.name)

    if params.has("properties"):
        if debug_mode:
            _report("Setting properties on node")
        var properties = params.properties
        for property in properties:
            var value = properties[property]
            value = _convert_property_value(new_node, property, value)
            if debug_mode:
                _report("Setting property: " + property + " = " + str(value))
            new_node.set(property, value)

    parent.add_child(new_node)
    new_node.owner = scene_root
    if debug_mode:
        _report("Node added to parent and ownership set")

    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        _report("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            _report("Saving scene to: " + absolute_scene_path)
        var save_error = _save_resource(packed_scene, absolute_scene_path)
        if debug_mode:
            _report("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        if save_error == OK:
            if debug_mode:
                var file_check_after = FileAccess.file_exists(absolute_scene_path)
                _report("File exists check after save: " + str(file_check_after))
                if file_check_after:
                    _report("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
                else:
                    _fail("File reported as saved but does not exist at: " + absolute_scene_path)
            else:
                _report("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
        else:
            _fail("Failed to save scene: " + str(save_error))
    else:
        _fail("Failed to pack scene: " + str(result))

func set_cells(params):
    _report("Setting cells on TileMapLayer in scene: " + params.scene_path)

    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        _report("Scene path (with res://): " + full_scene_path)

    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        _report("Absolute scene path: " + absolute_scene_path)

    if not FileAccess.file_exists(absolute_scene_path):
        _fail("Scene file does not exist at: " + absolute_scene_path)
        return

    var scene = _fresh(full_scene_path)
    if not scene is PackedScene:
        _fail("Failed to load scene: " + full_scene_path)
        return

    if debug_mode:
        _report("Scene loaded successfully")
    var scene_root = _track(scene.instantiate())
    if debug_mode:
        _report("Scene instantiated")

    # Find the TileMapLayer node
    var node_path = params.node_path
    if node_path.begins_with("root/"):
        node_path = node_path.substr(5)

    var layer = null
    if node_path == "" or node_path == "root":
        layer = scene_root
    else:
        layer = scene_root.get_node_or_null(node_path)

    if not layer:
        _fail("Node not found: " + params.node_path)
        return

    if not layer is TileMapLayer:
        _fail("Node is not a TileMapLayer: " + layer.get_class())
        return

    if debug_mode:
        _report("Found TileMapLayer: " + layer.name)

    # Set each cell
    var cells = params.cells
    var count = 0
    for cell in cells:
        var coords = Vector2i(int(cell.x), int(cell.y))
        var source_id = int(cell.source_id)
        var atlas_coords = Vector2i(int(cell.atlas_x), int(cell.atlas_y))
        layer.set_cell(coords, source_id, atlas_coords)
        count += 1

    if debug_mode:
        _report("Set " + str(count) + " cells")

    # Save the modified scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        _report("Pack result: " + str(result) + " (OK=" + str(OK) + ")")

    if result == OK:
        if debug_mode:
            _report("Saving scene to: " + absolute_scene_path)
        var save_error = _save_resource(packed_scene, absolute_scene_path)
        if debug_mode:
            _report("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        if save_error == OK:
            _report("Set " + str(count) + " cells on TileMapLayer successfully")
        else:
            _fail("Failed to save scene: " + str(save_error))
    else:
        _fail("Failed to pack scene: " + str(result))

func _load_scene(params) -> Array:
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)

    if not FileAccess.file_exists(absolute_scene_path):
        _fail("Scene file does not exist at: " + absolute_scene_path)
        return []

    var scene = _fresh(full_scene_path)
    if not scene is PackedScene:
        _fail("Failed to load scene: " + full_scene_path)
        return []

    var scene_root = _track(scene.instantiate())
    return [scene_root, full_scene_path, absolute_scene_path]

func _find_node(scene_root, node_path_str: String):
    var path = node_path_str
    if path.begins_with("root/"):
        path = path.substr(5)
    if path == "" or path == "root":
        return scene_root
    var node = scene_root.get_node_or_null(path)
    if not node:
        _fail("Node not found: " + node_path_str)
        return null
    return node

func _save_scene(scene_root, absolute_scene_path: String) -> void:
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if result != OK:
        _fail("Failed to pack scene: " + str(result))
        return
    var save_error = _save_resource(packed_scene, absolute_scene_path)
    if save_error != OK:
        _fail("Failed to save scene: " + str(save_error))
        return

func get_scene_tree(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]

    var tree_data = _serialize_node(scene_root, scene_root)
    var json_str = JSON.stringify(tree_data, "  ")
    _report(json_str)

func _serialize_node(node, scene_root) -> Dictionary:
    var data = {
        "name": node.name,
        "type": node.get_class(),
    }

    # Include script path if attached
    var script = node.get_script()
    if script and script.resource_path != "":
        data["script"] = script.resource_path

    # Include key properties based on node type
    var props = {}
    if node is Node2D:
        if node.position != Vector2.ZERO:
            props["position"] = [node.position.x, node.position.y]
        if node.scale != Vector2.ONE:
            props["scale"] = [node.scale.x, node.scale.y]
        if node.rotation != 0.0:
            props["rotation"] = node.rotation
    if node is CanvasItem:
        if not node.visible:
            props["visible"] = false
        if node.z_index != 0:
            props["z_index"] = node.z_index

    if props.size() > 0:
        data["properties"] = props

    # Recurse into children
    var children = []
    for child in node.get_children():
        children.append(_serialize_node(child, scene_root))
    if children.size() > 0:
        data["children"] = children

    return data

func set_node_properties(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return

    var properties = params.properties
    for property in properties:
        var value = properties[property]
        # The product dispatcher already validates/converts against the native
        # property type. Do not reinterpret a legitimate Dictionary with x/y keys.
        node.set(property, value)
        var actual = node.get(property)
        if actual != value and not (typeof(value) == TYPE_FLOAT and is_equal_approx(actual, value)):
            _fail("Engine rejected or adjusted property: " + property)
            return
        log_debug("Set " + property + " = " + str(value))

    _save_scene(scene_root, absolute_scene_path)
    _report("Properties set successfully on node: " + params.node_path)

func _convert_property_value(node, property: String, value):
    """Convert JSON values (arrays/dicts) to Godot types based on the node's property type."""
    if value is Array:
        if value.size() == 2:
            var prop_type = _get_property_type(node, property)
            if prop_type == "Vector2":
                return Vector2(value[0], value[1])
            elif prop_type == "Vector2i":
                return Vector2i(int(value[0]), int(value[1]))
        elif value.size() == 3:
            var prop_type = _get_property_type(node, property)
            if prop_type == "Vector3":
                return Vector3(value[0], value[1], value[2])
            elif prop_type == "Vector3i":
                return Vector3i(int(value[0]), int(value[1]), int(value[2]))
            elif prop_type == "Color":
                return Color(value[0], value[1], value[2])
        elif value.size() == 4:
            var prop_type = _get_property_type(node, property)
            if prop_type == "Color":
                return Color(value[0], value[1], value[2], value[3])
            elif prop_type == "Rect2":
                return Rect2(value[0], value[1], value[2], value[3])
            elif prop_type == "Rect2i":
                return Rect2i(int(value[0]), int(value[1]), int(value[2]), int(value[3]))
    elif value is Dictionary:
        if value.has("r") and value.has("g") and value.has("b"):
            return Color(value.r, value.g, value.b, value.get("a", 1.0))
        elif value.has("x") and value.has("y"):
            if value.has("z"):
                return Vector3(value.x, value.y, value.z)
            else:
                return Vector2(value.x, value.y)
    return value

func _get_property_type(node, property_name: String) -> String:
    for prop in node.get_property_list():
        if prop.name == property_name:
            match prop.type:
                TYPE_VECTOR2:
                    return "Vector2"
                TYPE_VECTOR2I:
                    return "Vector2i"
                TYPE_VECTOR3:
                    return "Vector3"
                TYPE_VECTOR3I:
                    return "Vector3i"
                TYPE_COLOR:
                    return "Color"
                TYPE_RECT2:
                    return "Rect2"
                TYPE_RECT2I:
                    return "Rect2i"
    return ""

func create_resource(params):
    var full_resource_path = params.resource_path
    if not full_resource_path.begins_with("res://"):
        full_resource_path = "res://" + full_resource_path

    var resource = null

    # If a script path is provided, load it and create an instance
    if params.has("script_path") and params.script_path != "":
        var full_script_path = params.script_path
        if not full_script_path.begins_with("res://"):
            full_script_path = "res://" + full_script_path
        var script = _fresh(full_script_path)
        if not script:
            _fail("Failed to load script: " + full_script_path)
            return
        resource = Resource.new()
        resource.set_script(script)
    else:
        # Try to create by class name
        var resource_type = params.resource_type
        if ClassDB.class_exists(resource_type) and ClassDB.can_instantiate(resource_type):
            resource = ClassDB.instantiate(resource_type)
        else:
            resource = Resource.new()

    if not resource:
        _fail("Failed to create resource of type: " + params.resource_type)
        return

    # Set properties
    if params.has("properties"):
        var properties = params.properties
        for property in properties:
            resource.set(property, properties[property])

    # Ensure directory exists
    var dir_path = full_resource_path.get_base_dir()
    if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir_path)):
        DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(dir_path))

    var save_error = _save_resource(resource, full_resource_path)
    if save_error != OK:
        _fail("Failed to save resource: " + str(save_error))
        return

    _report("Resource created at: " + params.resource_path)

func remove_node(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node_path = params.node_path
    if node_path == "root" or node_path == "":
        _fail("Cannot remove the root node")
        return

    var node = _find_node(scene_root, node_path)
    if not errors.is_empty():
        return
    var node_name = node.name
    node.get_parent().remove_child(node)
    node.free()

    _save_scene(scene_root, absolute_scene_path)
    _report("Node '" + node_name + "' removed successfully")

func reparent_node(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return
    var new_parent = _find_node(scene_root, params.new_parent_path)
    if not errors.is_empty():
        return

    var node_name = node.name
    node.get_parent().remove_child(node)
    new_parent.add_child(node)
    node.owner = scene_root

    # Re-set owner for all descendants so they persist in the scene
    _set_owner_recursive(node, scene_root)

    _save_scene(scene_root, absolute_scene_path)
    _report("Node '" + node_name + "' reparented to '" + new_parent.name + "'")

func _set_owner_recursive(node, owner):
    for child in node.get_children():
        child.owner = owner
        _set_owner_recursive(child, owner)

func rename_node(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node_path = params.node_path
    var new_name = params.new_name

    if node_path == "root" or node_path == "":
        # Rename the root node
        var old_name = scene_root.name
        scene_root.name = new_name
        _save_scene(scene_root, absolute_scene_path)
        _report("Root node renamed from '" + old_name + "' to '" + new_name + "'")
        return

    var node = _find_node(scene_root, node_path)
    if not errors.is_empty():
        return
    var old_name = node.name
    node.name = new_name

    _save_scene(scene_root, absolute_scene_path)
    _report("Node renamed from '" + old_name + "' to '" + new_name + "'")

func connect_signal_op(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var source = _find_node(scene_root, params.source_node_path)
    if not errors.is_empty():
        return
    var target = _find_node(scene_root, params.target_node_path)
    if not errors.is_empty():
        return

    var signal_name = params.signal_name
    var method_name = params.method_name

    if not source.has_signal(signal_name):
        _fail("Signal '" + signal_name + "' not found on node: " + params.source_node_path)
        return

    source.connect(signal_name, Callable(target, method_name), Object.CONNECT_PERSIST)

    _save_scene(scene_root, absolute_scene_path)
    _report("Signal '" + signal_name + "' connected from '" + source.name + "' to '" + target.name + "." + method_name + "'")

func get_tile_data(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return

    if not node is TileMapLayer:
        _fail("Node is not a TileMapLayer: " + node.get_class())
        return

    var used_cells = node.get_used_cells()
    var cells = []
    for coords in used_cells:
        var source_id = node.get_cell_source_id(coords)
        var atlas_coords = node.get_cell_atlas_coords(coords)
        cells.append({
            "x": coords.x,
            "y": coords.y,
            "source_id": source_id,
            "atlas_x": atlas_coords.x,
            "atlas_y": atlas_coords.y
        })

    var output = {"cell_count": cells.size(), "cells": cells}
    _report(JSON.stringify(output, "  "))

func create_tileset(params):
    var full_resource_path = params.resource_path
    if not full_resource_path.begins_with("res://"):
        full_resource_path = "res://" + full_resource_path

    var tileset = TileSet.new()

    # Set tile size
    if params.has("tile_size"):
        var ts = params.tile_size
        tileset.tile_size = Vector2i(int(ts.x), int(ts.y))
    else:
        tileset.tile_size = Vector2i(16, 16)

    # Add custom data layers
    if params.has("custom_data_layers"):
        var layers = params.custom_data_layers
        for i in range(layers.size()):
            var layer = layers[i]
            tileset.add_custom_data_layer()
            tileset.set_custom_data_layer_name(i, layer.name)
            match layer.type:
                "bool":
                    tileset.set_custom_data_layer_type(i, TYPE_BOOL)
                "int":
                    tileset.set_custom_data_layer_type(i, TYPE_INT)
                "float":
                    tileset.set_custom_data_layer_type(i, TYPE_FLOAT)
                "string":
                    tileset.set_custom_data_layer_type(i, TYPE_STRING)
                _:
                    tileset.set_custom_data_layer_type(i, TYPE_BOOL)
            log_debug("Added custom data layer: " + layer.name + " (" + layer.type + ")")

    # Add atlas sources
    var atlas_sources = params.atlas_sources
    for source_def in atlas_sources:
        var full_texture_path = source_def.texture_path
        if not full_texture_path.begins_with("res://"):
            full_texture_path = "res://" + full_texture_path

        var texture = _fresh(full_texture_path)
        if not texture:
            _fail("Failed to load texture: " + full_texture_path)
            return

        var atlas_source = TileSetAtlasSource.new()
        atlas_source.texture = texture
        atlas_source.texture_region_size = tileset.tile_size

        # Auto-create tiles for the entire texture
        var tex_size = texture.get_size()
        var cols = int(tex_size.x) / tileset.tile_size.x
        var rows = int(tex_size.y) / tileset.tile_size.y
        for row in range(rows):
            for col in range(cols):
                var atlas_coords = Vector2i(col, row)
                atlas_source.create_tile(atlas_coords)

        tileset.add_source(atlas_source)
        log_debug("Added atlas source: " + full_texture_path + " (" + str(cols) + "x" + str(rows) + " tiles)")

    # Ensure directory exists
    var dir_path = full_resource_path.get_base_dir()
    var abs_dir = ProjectSettings.globalize_path(dir_path)
    if not DirAccess.dir_exists_absolute(abs_dir):
        DirAccess.make_dir_recursive_absolute(abs_dir)

    var save_error = _save_resource(tileset, full_resource_path)
    if save_error != OK:
        _fail("Failed to save TileSet: " + str(save_error))
        return

    _report("TileSet created at: " + params.resource_path)

func add_to_group(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return
    var groups: Array = params.groups if params.has("groups") else [params.group]

    for group_name in groups:
        if not node.is_in_group(group_name):
            node.add_to_group(group_name, true)

    _save_scene(scene_root, absolute_scene_path)
    _report("Added node '" + params.node_path + "' to groups: " + str(groups))

func remove_from_group(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return
    var groups: Array = params.groups if params.has("groups") else [params.group]

    for group_name in groups:
        if node.is_in_group(group_name):
            node.remove_from_group(group_name)

    _save_scene(scene_root, absolute_scene_path)
    _report("Removed node '" + params.node_path + "' from groups: " + str(groups))

func instantiate_scene(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var child_scene_path = params.child_scene_path
    if not child_scene_path.begins_with("res://"):
        child_scene_path = "res://" + child_scene_path

    var child_scene = _fresh(child_scene_path)
    if not child_scene is PackedScene:
        _fail("Failed to load child scene: " + child_scene_path)
        return

    var instance = _track(child_scene.instantiate())

    if params.has("node_name") and params.node_name != "":
        instance.name = params.node_name

    var parent = scene_root
    if params.has("parent_node_path") and params.parent_node_path != "":
        parent = _find_node(scene_root, params.parent_node_path)
        if not errors.is_empty():
            return

    parent.add_child(instance)
    instance.owner = scene_root
    _set_owner_recursive(instance, scene_root)

    if params.has("position") and instance is Node2D:
        instance.position = Vector2(params.position.x, params.position.y)
    elif params.has("position") and instance is Node3D:
        instance.position = Vector3(params.position.x, params.position.y, params.position.get("z", 0))

    _save_scene(scene_root, absolute_scene_path)
    _report("Scene '" + child_scene_path + "' instantiated as '" + instance.name + "'")

func add_animation(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return
    if not node is AnimationPlayer:
        _fail("Node is not an AnimationPlayer: " + params.node_path)
        return

    var anim_player: AnimationPlayer = node
    var anim_name: String = params.animation_name
    var anim_length: float = params.get("length", 1.0)
    var anim_loop: bool = params.get("loop", false)

    var animation = params.get("animation", Animation.new())
    animation.length = anim_length
    if anim_loop:
        animation.loop_mode = Animation.LOOP_LINEAR

    if params.has("tracks"):
        for track_data in params.tracks:
            var track_type = Animation.TYPE_VALUE
            var type_str = track_data.get("type", "value")
            match type_str:
                "value":
                    track_type = Animation.TYPE_VALUE
                "method":
                    track_type = Animation.TYPE_METHOD
                "bezier":
                    track_type = Animation.TYPE_BEZIER

            var track_idx = animation.add_track(track_type)
            animation.track_set_path(track_idx, NodePath(track_data.path))

            if track_data.has("interpolation"):
                match track_data.interpolation:
                    "nearest":
                        animation.track_set_interpolation_type(track_idx, Animation.INTERPOLATION_NEAREST)
                    "linear":
                        animation.track_set_interpolation_type(track_idx, Animation.INTERPOLATION_LINEAR)
                    "cubic":
                        animation.track_set_interpolation_type(track_idx, Animation.INTERPOLATION_CUBIC)

            if track_data.has("keyframes"):
                for kf in track_data.keyframes:
                    var time: float = kf.time
                    var value = kf.value
                    if value is Dictionary:
                        if value.has("x") and value.has("y"):
                            if value.has("z"):
                                value = Vector3(value.x, value.y, value.z)
                            else:
                                value = Vector2(value.x, value.y)
                        elif value.has("r") and value.has("g"):
                            value = Color(value.r, value.g, value.b, value.get("a", 1.0))
                    animation.track_insert_key(track_idx, time, value)

    var lib = anim_player.get_animation_library("") if anim_player.has_animation_library("") else null
    if not lib:
        lib = AnimationLibrary.new()
        anim_player.add_animation_library("", lib)
    lib.add_animation(anim_name, animation)

    _save_scene(scene_root, absolute_scene_path)
    _report("Animation '" + anim_name + "' added with " + str(animation.get_track_count()) + " tracks")

func duplicate_node_op(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]
    var absolute_scene_path = result[2]

    var source_node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return
    var duplicate = _track(source_node.duplicate())

    if params.has("new_name") and params.new_name != "":
        duplicate.name = params.new_name

    var parent = source_node.get_parent()
    if params.has("parent_node_path") and params.parent_node_path != "":
        parent = _find_node(scene_root, params.parent_node_path)
        if not errors.is_empty():
            return

    parent.add_child(duplicate)
    duplicate.owner = scene_root
    _set_owner_recursive(duplicate, scene_root)

    _save_scene(scene_root, absolute_scene_path)
    _report("Node '" + params.node_path + "' duplicated as '" + duplicate.name + "'")

func get_node_properties(params):
    var result = _load_scene(params)
    if result.is_empty():
        return
    var scene_root = result[0]

    var node = _find_node(scene_root, params.node_path)
    if not errors.is_empty():
        return
    var output = {}

    if params.has("properties"):
        for prop_name in params.properties:
            var value = node.get(prop_name)
            output[prop_name] = _serialize_value(value)
    else:
        for prop in node.get_property_list():
            var pname = prop.name
            if pname.begins_with("_") or pname == "script":
                continue
            var value = node.get(pname)
            if value != null:
                output[pname] = _serialize_value(value)

    var json = JSON.new()
    _report(json.stringify(output, "  "))

func _serialize_value(value) -> Variant:
    if value is Vector2:
        return {"x": value.x, "y": value.y}
    elif value is Vector2i:
        return {"x": value.x, "y": value.y}
    elif value is Vector3:
        return {"x": value.x, "y": value.y, "z": value.z}
    elif value is Color:
        return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
    elif value is Rect2:
        return {"x": value.position.x, "y": value.position.y, "w": value.size.x, "h": value.size.y}
    elif value is NodePath:
        return str(value)
    elif value is Resource:
        return value.resource_path if value.resource_path != "" else str(value)
    elif value is Array:
        var arr = []
        for item in value:
            arr.append(_serialize_value(item))
        return arr
    return value
