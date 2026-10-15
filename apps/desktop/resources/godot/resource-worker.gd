# Application-owned Headless editor; selected native editing functions come from Vollkorn.
extends SceneTree

const VollkornEdit = preload("vollkorn-edit.gd")
var native_edit = VollkornEdit.new()
var started = false
# Logger receives parser diagnostics synchronously; stderr may arrive after the
# protocol response. Bound captured messages and reset before each edit request.
class ScriptDiagnostics extends Logger:
	var messages: Array[String] = []
	var resource_load_failed = false
	func _log_error(_function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, _error_type: int, _backtraces: Array[ScriptBacktrace]) -> void:
		if _error_type == Logger.ERROR_TYPE_ERROR and (file.ends_with("resource_format_text.cpp") or file.ends_with("resource_loader.cpp")):
			resource_load_failed = true
		if messages.size() < 8:
			messages.append(("%s:%s: %s %s" % [file, line, code, rationale]).left(1500))
var script_diagnostics = ScriptDiagnostics.new()
# Explicit short-lived edit groups. Only native-tool target files are tracked.
var transaction_active = false
var transaction_files: Dictionary = {}
var undo_files: Dictionary = {}
const TRANSACTION_LIMIT = 16 * 1024 * 1024

func _process(_delta: float) -> bool:
	if started:
		return false
	started = true
	OS.add_logger(script_diagnostics)
	if native_edit == null:
		printerr("Native edit module failed to initialize")
		quit(1)
		return true
	# As in Vollkorn, wait for SceneTree startup and autoload registration.
	print("OPENGAME_RESOURCE_READY")
	while true:
		var line = OS.read_string_from_stdin(65536)
		if line.is_empty():
			break
		var request = JSON.parse_string(line)
		if not request is Dictionary:
			respond({"error": "Invalid request"})
			continue
		if request.get("operation") == "stop":
			if transaction_active:
				var rollback = restore_files(transaction_files)
				if rollback.has("error"):
					printerr(rollback.error)
			respond({"message": "Worker stopped"})
			break
		respond(dispatch(request))
	quit()
	return false

func respond(result: Dictionary) -> void:
	print("OPENGAME_RESOURCE_RESULT" + JSON.stringify(result))

func fresh(path: String) -> Resource:
	# Ignore both the root cache and all dependency caches on every operation.
	return ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE_DEEP)

func decode(text: String) -> Variant:
	return str_to_var(text)

func property_info(resource: Object, property: String) -> Dictionary:
	for info in resource.get_property_list():
		if info.name == property and not property.begins_with("_") and property != "script" and info.usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR) and not info.usage & PROPERTY_USAGE_READ_ONLY:
			return info
	return {}

func resource_load_error(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {"error": "Resource file does not exist: %s. Check the project-relative path before retrying." % path}
	return {"error": "Resource file exists but Godot could not load it: %s. Run godot-project check for this project to import assets and report resource/script errors, fix those errors, then retry." % path}

func literal_value(target: Object, property: String, text: String, info: Dictionary) -> Dictionary:
	var value = decode(text)
	if value == null and text.strip_edges() != "null":
		var reference_tool = "godot_node_reference" if target is Node else "godot_resource_reference"
		return {"error": "Invalid Godot literal for property '%s'. value must be a Godot literal (e.g. true, 1.5, Vector2(1, 2)); string values need double quotes, e.g. \"hello\". Do not put a bare res:// or asset path in value. For resource links use %s with the same target/property and reference=the project-relative resource path, not value." % [property, reference_tool]}
	var vector_types = [TYPE_VECTOR2, TYPE_VECTOR2I, TYPE_VECTOR3, TYPE_VECTOR3I, TYPE_COLOR, TYPE_RECT2, TYPE_RECT2I]
	# The imported converter assumes numeric components. Validate them before
	# invoking constructors, otherwise malformed model input aborts the worker.
	if int(info.type) in vector_types and (value is Array or value is Dictionary):
		var components = value if value is Array else value.values()
		for component in components:
			if not typeof(component) in [TYPE_INT, TYPE_FLOAT] or not is_finite(float(component)):
				return {"error": "Vector/color/rectangle components must be finite numbers"}
			if int(info.type) in [TYPE_VECTOR2I, TYPE_VECTOR3I, TYPE_RECT2I] and float(component) != floor(float(component)):
				return {"error": "Integer vector/rectangle components must be whole numbers"}
		value = native_edit._convert_property_value(target, property, value)
	return {"value": value}

func matches(value: Variant, info: Dictionary) -> bool:
	var expected = int(info.type)
	if expected == TYPE_OBJECT:
		if value == null:
			return true
		if not value is Resource:
			return false
		var classes = str(info.hint_string).split(",")
		for type in classes:
			if value.is_class(type):
				return true
			# Object.is_class knows native classes, not GDScript class_name.
			var script = value.get_script()
			if script is Script and not script.can_instantiate():
				continue
			while script is Script:
				if script.get_global_name() == type:
					return true
				script = script.get_base_script()
		return str(info.hint_string).is_empty()
	if expected in [TYPE_STRING_NAME, TYPE_NODE_PATH] and typeof(value) == TYPE_STRING:
		return true
	return typeof(value) == expected or (expected in [TYPE_INT, TYPE_FLOAT] and typeof(value) in [TYPE_INT, TYPE_FLOAT])

func file_snapshot(path: String) -> Dictionary:
	# Journals must not follow aliases that can later be redirected outside the
	# project between the target edit and a path-less rollback request.
	var cursor = ProjectSettings.globalize_path(path)
	var root = ProjectSettings.globalize_path("res://").trim_suffix("/")
	while cursor != root and cursor != cursor.get_base_dir():
		var parent = DirAccess.open(cursor.get_base_dir())
		if parent == null or parent.is_link(cursor.get_file()):
			return {"error": "Edit groups require real project paths without symlinks: " + path}
		cursor = cursor.get_base_dir()
	if not FileAccess.file_exists(path):
		return {"exists": false, "bytes": PackedByteArray()}
	var file = FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {"error": "Cannot read transaction file: " + path}
	if file.get_length() > TRANSACTION_LIMIT:
		return {"error": "Transaction file exceeds 16 MiB; use smaller edit groups"}
	return {"exists": true, "bytes": file.get_buffer(file.get_length())}

func restore_files(files: Dictionary) -> Dictionary:
	# Preflight every file before touching any. Never overwrite intervening file edits.
	for path in files:
		var current = file_snapshot(path)
		if current.has("error"):
			return current
		if current != files[path].after:
			return {"error": "Rollback conflict; file changed outside this edit group: " + path + ". Inspect files; no rollback performed."}
	for path in files:
		var before = files[path].before
		if before.exists:
			var file = FileAccess.open(path, FileAccess.WRITE)
			if file == null:
				return {"error": "Rollback could not write " + path + "; inspect files before continuing"}
			file.store_buffer(before.bytes)
			file.close()
		else:
			var error = DirAccess.remove_absolute(path)
			if error != OK and FileAccess.file_exists(path):
				return {"error": "Rollback could not remove " + path}
	return {"data": {"restored_files": files.keys()}}

func edit_transaction(action: String) -> Dictionary:
	match action:
		"begin":
			if transaction_active:
				return {"error": "An edit group is already open; commit or rollback it first"}
			transaction_active = true
			transaction_files = {}
			return {"data": {"transaction": "active"}}
		"commit":
			if not transaction_active:
				return {"error": "No edit group is open"}
			undo_files = transaction_files
			transaction_files = {}
			transaction_active = false
			return {"data": {"transaction": "committed", "files": undo_files.keys()}}
		"rollback", "undo":
			if action == "undo" and transaction_active:
				return {"error": "Commit or rollback the open group before undo"}
			if action == "rollback" and not transaction_active:
				return {"error": "No edit group is open"}
			var files = transaction_files if action == "rollback" else undo_files
			if action == "undo" and files.is_empty():
				return {"error": "No committed edit group is available in this worker"}
			var result = restore_files(files)
			if not result.has("error"):
				files.clear()
				transaction_active = false
			return result
	return {"error": "Unknown transaction action"}

func edit_batch(operations: Array, prepare_only: bool = false) -> Dictionary:
	if transaction_active:
		return {"error": "An edit group is already open; commit or rollback it before a batch. Existing group was not changed."}
	if operations.is_empty() or operations.size() > 16:
		return {"error": "Use 1–16 batch operations"}
	var allowed = ["create", "set", "reference", "scene_create", "node_add", "node_set", "node_reference"]
	for step in operations:
		if not step is Dictionary or not step.get("operation", "") in allowed:
			return {"error": "Unsupported batch operation; no edits performed"}
	edit_transaction("begin")
	var results = []
	for index in operations.size():
		var step = operations[index]
		var result = dispatch(step)
		var summary = JSON.stringify(result)
		results.append({"index": index, "operation": step.operation, "ok": not result.has("error"), "result": summary.left(1000), "truncated": summary.length() > 1000})
		if result.has("error"):
			# Some preflight failures return before dispatch's automatic rollback.
			var rollback = edit_transaction("rollback") if transaction_active else {}
			for skipped in range(index + 1, operations.size()):
				results.append({"index": skipped, "operation": operations[skipped].operation, "status": "not_run"})
			return {"error": result.error, "data": {"status": "failed", "failed_index": index, "results": results, "rollback": "failed" if rollback.has("error") else "completed", "rollback_error": rollback.get("error", "")}}
	if prepare_only:
		return {"data": {"status": "prepared", "results": results, "files": transaction_files.keys()}}
	var committed = edit_transaction("commit")
	return {"data": {"status": "committed", "results": results, "files": committed.data.files, "undo": "Latest worker-local edit group; undo restores this whole batch. History expires when worker stops."}}

func dispatch(args: Dictionary) -> Dictionary:
	if args.operation == "worker_state":
		return {"transaction_active": transaction_active, "has_undo": not undo_files.is_empty()}
	if args.operation in ["batch", "batch_prepare"]:
		return edit_batch(args.operations, args.operation == "batch_prepare")
	if args.operation == "transaction":
		return edit_transaction(args.action)
	var mutating = not args.operation in ["inspect", "scene_inspect", "node_inspect", "tile_cells"]
	var path: String = args.path
	if transaction_active and mutating:
		var current = file_snapshot(path)
		if current.has("error"):
			return current
		if transaction_files.has(path) and current != transaction_files[path].after:
			return {"error": "Edit group conflict; target changed outside the native tools: " + path}
		if not transaction_files.has(path):
			var size = current.bytes.size()
			for entry in transaction_files.values():
				size += entry.before.bytes.size()
			if size > TRANSACTION_LIMIT:
				return {"error": "Edit group exceeds 16 MiB; commit smaller groups"}
			transaction_files[path] = {"before": current, "after": current}
	var result = dispatch_edit(args)
	if transaction_active and mutating:
		transaction_files[path].after = file_snapshot(path)
		if result.has("error"):
			var rollback = restore_files(transaction_files)
			if rollback.has("error"):
				result.error += "; " + rollback.error
			else:
				transaction_files.clear()
				transaction_active = false
				result.error += "; edit group rolled back"
	return result

func dispatch_edit(args: Dictionary) -> Dictionary:
	# Scope diagnostics to this synchronous request, never replay a prior failure.
	script_diagnostics.messages.clear()
	script_diagnostics.resource_load_failed = false
	var result = dispatch_edit_inner(args)
	if result.has("error"):
		var detail = str(result.error)
		if not script_diagnostics.messages.is_empty() and not detail.contains("Godot diagnostics:"):
			detail += "\nGodot diagnostics (this request, at most 8 entries):\n" + "\n".join(script_diagnostics.messages)
		if (not script_diagnostics.messages.is_empty() or detail.to_lower().contains("load")) and not detail.contains("godot-project check"):
			detail += "\nRun godot-project check for this project to report resource/script errors, fix the referenced file or dependency, then retry this operation."
		result.error = detail
	return result

func dispatch_edit_inner(args: Dictionary) -> Dictionary:
	if args.operation in ["create", "scene_create", "scene_inspect", "scene_instance", "node_add", "node_inspect", "node_set", "node_reference", "node_edit", "signal_connect", "tileset_create", "tile_cell", "tile_cells", "animation_bind"]:
		native_edit.errors.clear()
		var result = dispatch_native(args)
		native_edit.cleanup()
		return result
	var path: String = args.path
	var operation: String = args.operation
	var resource: Resource
	resource = fresh(path)
	if resource == null or script_diagnostics.resource_load_failed:
		return resource_load_error(path)
	var target = resource
	var subresource: String = args.get("subresource", "")
	if not subresource.is_empty():
		for part in subresource.split(":"):
			if property_info(target, part).is_empty():
				return {"error": "Unknown subresource property: " + part}
			var child = target.get(part)
			if not child is Resource:
				return {"error": "Property is not a subresource: " + part}
			target = child
	if operation != "inspect" and target != resource and not target.resource_path.is_empty() and not target.resource_path.begins_with(path + "::"):
		return {"error": "Edit an external subresource through its own file path"}
	match operation:
		"inspect":
			var properties = []
			for info in target.get_property_list():
				if not str(info.name).begins_with("_") and info.name != "script" and info.usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR):
					var value = target.get(info.name)
					properties.append({"name": info.name, "type": type_string(info.type), "resource_types": info.hint_string, "value": var_to_str(value).left(512)})
			var summary = {"class": target.get_class(), "properties": properties}
			if target is Animation:
				var tracks = []
				for index in target.get_track_count():
					tracks.append({"index": index, "path": str(target.track_get_path(index)), "keys": target.track_get_key_count(index)})
				summary.tracks = tracks
			if target is TileSet:
				var sources = []
				for index in target.get_source_count():
					sources.append(target.get_source_id(index))
				summary.sources = sources
			return summary
		"set", "reference":
			var info = property_info(target, args.property)
			if info.is_empty():
				return {"error": "Unknown or non-editable resource property '%s' on class=%s, path=%s, subresource=%s. Use godot_resource_inspect with the same path/subresource to read available properties and types before retrying." % [args.property, target.get_class(), path, args.get("subresource", "")]}
			var decoded = {"value": fresh(args.reference)} if operation == "reference" else literal_value(target, args.property, args.value, info)
			if decoded.has("error"):
				return decoded
			var value = decoded.value
			if operation == "reference" and value == null:
				return resource_load_error(args.reference)
			if int(info.type) == TYPE_OBJECT and value is String:
				return {"error": "This property requires a resource, not a string path. Use godot_resource_reference with the same target/property and reference=the project-relative resource path."}
			if not matches(value, info):
				var reason = "Property requires " + type_string(info.type) + " " + str(info.hint_string)
				if int(info.type) == TYPE_OBJECT:
					reason += ". Use godot_resource_reference with the same project/path/property/subresource and reference=the existing res:// resource path of the required class; do not pass a path or resource description as a set value."
				return {"error": reason}
			target.set(args.property, value)
			if target.get(args.property) != value and not (typeof(value) == TYPE_FLOAT and is_equal_approx(target.get(args.property), value)):
				return {"error": "Engine rejected or adjusted the value; no file saved"}
		"curve_point":
			if not target is Curve:
				return {"error": "Expected Curve"}
			var point = Vector2(args.x, args.y)
			if point.x < target.min_domain or point.x > target.max_domain or point.y < target.min_value or point.y > target.max_value:
				return {"error": "Point outside Curve domain/value range"}
			target.add_point(point)
		"gradient_point":
			if not target is Gradient:
				return {"error": "Expected Gradient"}
			if args.offset < 0 or args.offset > 1 or not Color.html_is_valid(args.color):
				return {"error": "Use offset 0..1 and an HTML hex color"}
			target.add_point(args.offset, Color.html(args.color))
		"animation_track":
			if not target is Animation:
				return {"error": "Expected Animation"}
			var index = target.add_track(Animation.TYPE_VALUE)
			target.track_set_path(index, NodePath(args.node_property))
			var error = ResourceSaver.save(resource, path)
			return {"track": index} if error == OK else {"error": "Save failed: " + error_string(error)}
		"animation_key":
			if not target is Animation:
				return {"error": "Expected Animation"}
			if args.track < 0 or args.track >= target.get_track_count() or target.track_get_type(args.track) != Animation.TYPE_VALUE:
				return {"error": "Expected existing value track index"}
			if args.time < 0 or args.time > target.length:
				return {"error": "Key time must be within animation length"}
			var value = decode(args.value)
			if value == null and str(args.value).strip_edges() != "null":
				return {"error": "Invalid key literal"}
			target.track_insert_key(args.track, args.time, value)
		"theme_item":
			if not target is Theme:
				return {"error": "Expected Theme"}
			var kinds = {"color": Theme.DATA_TYPE_COLOR, "constant": Theme.DATA_TYPE_CONSTANT, "font_size": Theme.DATA_TYPE_FONT_SIZE, "stylebox": Theme.DATA_TYPE_STYLEBOX, "icon": Theme.DATA_TYPE_ICON, "font": Theme.DATA_TYPE_FONT}
			var value = fresh(args.reference) if args.get("reference", "") != "" else decode(args.get("value", ""))
			var expected = {"color": TYPE_COLOR, "constant": TYPE_INT, "font_size": TYPE_INT, "stylebox": TYPE_OBJECT, "icon": TYPE_OBJECT, "font": TYPE_OBJECT}
			if typeof(value) != expected[args.kind]:
				return {"error": "Theme item has wrong value type"}
			var classes = {"stylebox": "StyleBox", "icon": "Texture2D", "font": "Font"}
			if args.kind in classes and (value == null or not value.is_class(classes[args.kind])):
				return {"error": "Wrong referenced resource class"}
			target.set_theme_item(kinds[args.kind], args.item, args.control, value)
		"tile_atlas":
			if not target is TileSet:
				return {"error": "Expected TileSet"}
			if target.has_source(args.source):
				return {"error": "Source id already exists"}
			var texture = fresh(args.reference)
			if not texture is Texture2D:
				return {"error": "Expected imported Texture2D"}
			var atlas = TileSetAtlasSource.new()
			atlas.texture = texture
			atlas.texture_region_size = Vector2i(args.width, args.height)
			target.add_source(atlas, args.source)
		"tile_create":
			if not target is TileSet or not target.has_source(args.source):
				return {"error": "Expected TileSet with existing source"}
			var atlas = target.get_source(args.source)
			if not atlas is TileSetAtlasSource:
				return {"error": "Expected atlas source"}
			var cell = Vector2i(args.x, args.y)
			if not atlas.has_room_for_tile(cell, Vector2i.ONE, 1, Vector2i.ZERO, 1):
				return {"error": "Tile overlaps or is outside atlas"}
			atlas.create_tile(cell)
		"create":
			pass
		_:
			return {"error": "Unknown resource operation"}
	if script_diagnostics.resource_load_failed:
		return {"error": "Referenced resource dependencies failed to load. Edit was not saved; original references are preserved."}
	var error = ResourceSaver.save(resource, path)
	return {"path": path, "class": resource.get_class(), "saved": true} if error == OK else {"error": "Save failed: " + error_string(error)}

func class_is(type: String, parent: String) -> bool:
	return ClassDB.class_exists(type) and ClassDB.can_instantiate(type) and (type == parent or ClassDB.is_parent_class(type, parent))

func valid_name(name: String) -> bool:
	return not name.is_empty() and name.validate_node_name() == name

func signal_argument_error(source: Node, target: Node, signal_name: String, method_name: String) -> String:
	var count = 0
	for signal_info in source.get_signal_list():
		if signal_info.name == signal_name:
			count = signal_info.args.size()
			break
	for method in target.get_method_list():
		if method.name != method_name:
			continue
		var maximum = method.args.size()
		var minimum = maximum - method.default_args.size()
		var variadic = (int(method.flags) & METHOD_FLAG_VARARG) != 0
		if count < minimum or (not variadic and count > maximum):
			var accepted = "%s or more" % minimum if variadic else "%s..%s" % [minimum, maximum]
			return "Signal '%s' emits %s argument(s), but method '%s' accepts %s. No connection saved. Adjust the method signature, or use GDScript Callable.bind/unbind when argument adaptation is needed; this native connect tool does not bind/unbind arguments." % [signal_name, count, method_name, accepted]
		break
	return ""

func explicit_script_bindings(tree: Dictionary) -> void:
	if not tree.has("script"):
		tree.script = null
	for child in tree.get("children", []):
		explicit_script_bindings(child)

func dispatch_native(args: Dictionary) -> Dictionary:
	var operation: String = args.operation
	var path: String = args.path
	if operation in ["create", "scene_create", "tileset_create"]:
		if FileAccess.file_exists(path):
			return {"error": "File already exists; inspect or edit it"}
	if operation == "create":
		if not class_is(args.type, "Resource"):
			return {"error": "Expected an instantiable built-in Resource class"}
		return native_edit.execute("create_resource", {"resource_path": path, "resource_type": args.type})
	if operation == "scene_create":
		if not class_is(args.type, "Node"):
			return {"error": "Expected an instantiable built-in Node class"}
		return native_edit.execute("create_scene", {"scene_path": path, "root_node_type": args.type})
	if operation == "tileset_create":
		var texture = fresh(args.reference)
		if not texture is Texture2D or script_diagnostics.resource_load_failed or args.width <= 0 or args.height <= 0:
			return {"error": "Expected a Texture2D and positive tile dimensions"}
		return native_edit.execute("create_tileset", {"resource_path": path, "tile_size": {"x": args.width, "y": args.height}, "atlas_sources": [{"texture_path": args.reference}]})
	var params = {"scene_path": path}
	if operation == "scene_inspect":
		var result = native_edit.execute("get_scene_tree", params)
		if result.has("data"):
			explicit_script_bindings(result.data)
			var packed = fresh(path)
			if packed is PackedScene:
				var state = packed.get_state()
				var connections = []
				for index in mini(state.get_connection_count(), 64):
					connections.append({"source": str(state.get_connection_source(index)), "signal": str(state.get_connection_signal(index)), "target": str(state.get_connection_target(index)), "method": str(state.get_connection_method(index))})
				result.data.saved_connections = connections
				result.data.saved_connections_truncated = state.get_connection_count() > 64
		return result
	# Validate against a fresh scene before invoking the upstream mutation.
	var loaded = native_edit._load_scene(params)
	if script_diagnostics.resource_load_failed:
		return {"error": "Scene dependencies failed to load: %s. Edit was not saved; original references are preserved." % path}
	if loaded.is_empty():
		return {"error": "; ".join(native_edit.errors)}
	var scene_root: Node = loaded[0]
	if operation == "scene_instance":
		if not fresh(args.reference) is PackedScene or script_diagnostics.resource_load_failed or not valid_name(args.name):
			return {"error": "Expected a PackedScene reference and valid instance name"}
		var parent = native_edit._find_node(scene_root, args.parent)
		if parent == null:
			return {"error": "; ".join(native_edit.errors)}
		if parent.has_node(NodePath(args.name)):
			return {"error": "Instance name already exists under parent"}
		params.merge({"child_scene_path": args.reference, "node_name": args.name, "parent_node_path": args.parent})
		return native_edit.execute("instantiate_scene", params)
	if operation == "node_add":
		if not class_is(args.type, "Node") or not valid_name(args.name):
			return {"error": "Expected a built-in Node class and valid name"}
		var parent = native_edit._find_node(scene_root, args.parent)
		if parent == null:
			return {"error": "; ".join(native_edit.errors)}
		if parent.has_node(NodePath(args.name)):
			return {"error": "Node name already exists under parent"}
		params.merge({"node_type": args.type, "node_name": args.name, "parent_node_path": args.parent})
		return native_edit.execute("add_node", params)
	var node = native_edit._find_node(scene_root, args.node)
	if node == null:
		return {"error": "; ".join(native_edit.errors)}
	params.node_path = args.node
	match operation:
		"node_inspect":
			return native_edit.execute("get_node_properties", params)
		"node_set", "node_reference":
			if operation == "node_reference" and args.property == "script":
				script_diagnostics.messages.clear()
				var script = fresh(args.reference)
				var can_instantiate = script is Script and script.can_instantiate()
				var base_type = script.get_instance_base_type() if script is Script else "unknown"
				if not can_instantiate or not node.is_class(base_type):
					var reason = "Script failed to load or compile" if not can_instantiate else "Script base class is incompatible with node class"
					var detail = "%s: script=%s, node=%s, node_class=%s, script_base=%s, can_instantiate=%s." % [reason, args.reference, args.node, node.get_class(), base_type, can_instantiate]
					if not script_diagnostics.messages.is_empty():
						detail += "\nGodot diagnostics:\n" + "\n".join(script_diagnostics.messages)
					return {"error": detail + "\nAttachment was not saved. Fix this script (or its extends base class), run godot-project check for this project, then retry godot_node_reference. Do not delete or recreate the project."}
				params.properties = {"script": script}
				return native_edit.execute("set_node_properties", params)
			var info = property_info(node, args.property)
			if info.is_empty():
				return {"error": "Unknown or non-editable node property '%s' on node=%s, node_class=%s, scene=%s. Use godot_scene_inspect with the same path, view='properties', node='%s' to read available properties and types before retrying." % [args.property, args.node, node.get_class(), path, args.node]}
			var decoded = {"value": fresh(args.reference)} if operation == "node_reference" else literal_value(node, args.property, args.value, info)
			if decoded.has("error"):
				return decoded
			var value = decoded.value
			if operation == "node_reference" and (value == null or script_diagnostics.resource_load_failed):
				return resource_load_error(args.reference)
			if int(info.type) == TYPE_OBJECT and value is String:
				return {"error": "This property requires a resource, not a string path. Use godot_node_reference with the same target/property and reference=the project-relative resource path."}
			if not matches(value, info):
				var reason = "Node property requires " + type_string(info.type) + " " + str(info.hint_string)
				if int(info.type) == TYPE_OBJECT:
					reason += ". Use godot_node_reference with the same project/path/property/node and reference=the existing res:// resource path of the required class; do not pass a path or resource description as a set value."
				return {"error": reason}
			params.properties = {args.property: value}
			return native_edit.execute("set_node_properties", params)
		"node_edit":
			var action: String = args.action
			var target: String = args.get("target", "")
			if action in ["remove", "reparent", "duplicate"] and node == scene_root:
				return {"error": "Cannot remove, reparent or duplicate the scene root"}
			if action in ["rename", "duplicate"]:
				if not valid_name(target):
					return {"error": "Expected a valid new node name"}
				if node.get_parent() != null and node.get_parent().has_node(NodePath(target)):
					return {"error": "New name already exists under parent"}
				params.new_name = target
			if action == "reparent":
				var parent = native_edit._find_node(scene_root, target)
				if parent == null or parent == node or node.is_ancestor_of(parent):
					return {"error": "Invalid or cyclic new parent"}
				if parent.has_node(NodePath(str(node.name))):
					return {"error": "Node name already exists under new parent"}
				params.new_parent_path = target
			if action in ["group_add", "group_remove"]:
				if target.is_empty():
					return {"error": "Specify a group name"}
				params.group = target
			var methods = {"remove": "remove_node", "rename": "rename_node", "reparent": "reparent_node", "duplicate": "duplicate_node_op", "group_add": "add_to_group", "group_remove": "remove_from_group"}
			return native_edit.execute(methods[action], params)
		"signal_connect":
			var target = native_edit._find_node(scene_root, args.target)
			if target == null or not node.has_signal(args.signal) or not target.has_method(args.method):
				return {"error": "Expected an existing signal, target node and method"}
			var argument_error = signal_argument_error(node, target, args.signal, args.method)
			if not argument_error.is_empty():
				return {"error": argument_error}
			if node.is_connected(args.signal, Callable(target, args.method)):
				return {"error": "Signal is already connected"}
			params.merge({"source_node_path": args.node, "target_node_path": args.target, "signal_name": args.signal, "method_name": args.method})
			return native_edit.execute("connect_signal_op", params)
		"animation_bind":
			var animation = fresh(args.reference)
			if script_diagnostics.resource_load_failed:
				return {"error": "Animation dependencies failed to load. Edit was not saved; original references are preserved."}
			if not node is AnimationPlayer or not animation is Animation or args.name.is_empty() or "/" in args.name or ":" in args.name:
				return {"error": "Expected AnimationPlayer, Animation resource and valid animation name"}
			params.merge({"animation_name": args.name, "animation": animation, "length": animation.length, "loop": animation.loop_mode == Animation.LOOP_LINEAR})
			return native_edit.execute("add_animation", params)
		"tile_cells":
			if not node is TileMapLayer:
				return {"error": "Expected TileMapLayer"}
			return native_edit.execute("get_tile_data", params)
		"tile_cell":
			if not node is TileMapLayer or node.tile_set == null:
				return {"error": "Expected TileMapLayer with an assigned TileSet"}
			if args.source != -1:
				if not node.tile_set.has_source(args.source):
					return {"error": "TileSet source does not exist"}
				var atlas = node.tile_set.get_source(args.source)
				if not atlas is TileSetAtlasSource or not atlas.has_tile(Vector2i(args.atlas_x, args.atlas_y)):
					return {"error": "Atlas tile does not exist"}
			params.cells = [{"x": args.x, "y": args.y, "source_id": args.source, "atlas_x": args.atlas_x, "atlas_y": args.atlas_y}]
			return native_edit.execute("set_cells", params)
	return {"error": "Unsupported native operation"}
