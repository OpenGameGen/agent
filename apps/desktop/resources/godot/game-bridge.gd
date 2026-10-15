extends Node
# UI traversal adapted from Erodenn/godot-mcp-runtime (MIT), commit 0492500.
# Signal collection follows Vollkorn input_receiver.gd: subscribe before input.
var _js: JavaScriptObject
var _callback: JavaScriptObject
var _events: Array = []
var _subscriptions: Dictionary = {}
var _sequence := 0
var _frozen := false
var _was_paused := false
var _busy := false
var _step_generation := 0
var _reproduction: RefCounted

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not OS.has_feature("web"):
		return
	_js = JavaScriptBridge.get_interface("openGame")
	_callback = JavaScriptBridge.create_callback(_receive)
	_js.dispatch = _callback
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	_js.ready = true

func _receive(args: Array) -> void:
	var id = args[0]
	var payload = JSON.parse_string(str(args[1]))
	if not payload is Dictionary:
		_js.respond(id, JSON.stringify({"error": "Invalid request"}))
		return
	var result: Dictionary = await _execute(payload)
	_js.respond(id, _encode_response(str(payload.get("command", "")), result))

func _encode_response(command: String, result: Dictionary) -> String:
	# Trace comparison must not collapse distinct floating-point observations.
	var encoded := JSON.stringify(result, "", true, command == "reproduce")
	return encoded if encoded.to_utf8_buffer().size() <= 131072 else JSON.stringify({"error": "Observation exceeds 128 KiB; read one property"})

func _value(value: Variant, depth: int = 0) -> Variant:
	if depth > 4:
		return "<depth limit>"
	if value is Vector2 or value is Vector2i:
		return {"x": value.x, "y": value.y}
	if value is Vector3 or value is Vector3i:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Array:
		var result: Array = []
		for item in value.slice(0, 100): result.append(_value(item, depth + 1))
		return result
	if value is Dictionary:
		var result := {}
		for key in value.keys().slice(0, 100): result[str(key)] = _value(value[key], depth + 1)
		return result
	if value is Object: return str(value)
	return value

func _property(value: Variant, property: String, serialized: bool = true) -> Dictionary:
	for part in property.split("."):
		if part.is_empty(): return {"error": "Property components must not be empty"}
		if value is Object:
			var found := false
			for info in value.get_property_list():
				if str(info.name) == part: found = true
			if not found: return {"error": "Unknown property component: " + part}
			value = value.get(part)
		elif value is Dictionary:
			if not value.has(part): return {"error": "Unknown dictionary key: " + part}
			value = value[part]
		elif value is Array:
			if not part.is_valid_int() or int(part) < 0 or int(part) >= value.size(): return {"error": "Array index out of bounds: " + part}
			value = value[int(part)]
		else:
			var members: Array = []
			match typeof(value):
				TYPE_VECTOR2, TYPE_VECTOR2I: members = ["x", "y"]
				TYPE_VECTOR3, TYPE_VECTOR3I: members = ["x", "y", "z"]
				TYPE_VECTOR4, TYPE_VECTOR4I, TYPE_QUATERNION: members = ["x", "y", "z", "w"]
				TYPE_RECT2, TYPE_RECT2I, TYPE_AABB: members = ["position", "size", "end"]
				TYPE_COLOR: members = ["r", "g", "b", "a", "r8", "g8", "b8", "a8", "h", "s", "v"]
				TYPE_TRANSFORM2D: members = ["x", "y", "origin"]
				TYPE_TRANSFORM3D: members = ["basis", "origin"]
				TYPE_BASIS: members = ["x", "y", "z"]
				TYPE_PROJECTION: members = ["x", "y", "z", "w"]
				TYPE_PLANE: members = ["normal", "d", "x", "y", "z"]
			if not members.has(part): return {"error": "Unknown or unsupported property component: " + part}
			value = value[part]
	return {"value": _value(value) if serialized else value}

func _node(path: String) -> Node:
	return get_node_or_null(NodePath(path))

func _ui(node: Node, items: Array) -> void:
	if items.size() >= 500: return
	if node is Control:
		var ctrl := node as Control
		if not ctrl.is_visible_in_tree(): return
		var rect := ctrl.get_global_rect()
		var item := {"path": str(ctrl.get_path()), "type": ctrl.get_class(), "x": rect.position.x, "y": rect.position.y, "width": rect.size.x, "height": rect.size.y}
		if ctrl is Button or ctrl is Label or ctrl is LineEdit or ctrl is TextEdit or ctrl is RichTextLabel: item["text"] = ctrl.text
		if ctrl is BaseButton: item["disabled"] = ctrl.disabled
		items.append(item)
	for child in node.get_children(): _ui(child, items)

func _tree(node: Node, items: Array, depth: int, max_depth: int, limit: int) -> bool:
	if items.size() >= limit: return true
	var item := {"path": str(node.get_path()), "name": str(node.name), "type": node.get_class(), "child_count": node.get_child_count(), "process_mode": node.process_mode}
	if node.get_script() != null: item["script"] = node.get_script().resource_path
	if not node.scene_file_path.is_empty(): item["scene"] = node.scene_file_path
	items.append(item)
	var truncated := depth >= max_depth and node.get_child_count() > 0
	if depth < max_depth:
		for child in node.get_children():
			if items.size() >= limit: return true
			if _tree(child, items, depth + 1, max_depth, limit): truncated = true
	return truncated

func _execute(p: Dictionary) -> Dictionary:
	var command := str(p.get("command", ""))
	if command == "scene":
		if _busy: return {"error": "A frame operation is still running"}
		var path := str(p.get("scene", ""))
		if path.is_empty(): path = str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if not ResourceLoader.exists(path, "PackedScene"): return {"error": "Scene not found in current resource pack"}
		var result := get_tree().change_scene_to_file(path)
		if result != OK: return {"error": "Scene switch failed: " + str(result)}
		if _frozen: get_tree().paused = _was_paused
		_frozen = false
		_events.clear()
		await get_tree().scene_changed
		await get_tree().process_frame
		await RenderingServer.frame_post_draw
		return {"scene": path, "scene_ready": true, "autoloads_preserved": true}
	if command == "frame":
		await get_tree().process_frame
		await RenderingServer.frame_post_draw
		return {"frame": Engine.get_process_frames()}
	if command == "ui":
		var items: Array = []
		_ui(get_tree().root, items)
		return {"elements": items, "coordinate_space": "Godot viewport", "viewport": _value(get_viewport().get_visible_rect().size)}
	if command == "tree":
		var root := _node(str(p.get("node_path", "/root")))
		if root == null: return {"error": "Node not found"}
		var depth := int(p.get("depth", 8))
		var limit := int(p.get("limit", 200))
		if depth < 0 or depth > 32 or limit < 1 or limit > 500: return {"error": "tree depth must be 0..32 and limit 1..500"}
		var items: Array = []
		var truncated := _tree(root, items, 0, depth, limit)
		return {"nodes": items, "truncated": truncated, "paused": get_tree().paused, "scene": get_tree().current_scene.scene_file_path if get_tree().current_scene != null else ""}
	if command == "metrics":
		return {"fps": Performance.get_monitor(Performance.TIME_FPS), "process_seconds": Performance.get_monitor(Performance.TIME_PROCESS), "physics_seconds": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS), "nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT), "static_memory_bytes": Performance.get_monitor(Performance.MEMORY_STATIC), "draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME), "process_frames": Engine.get_process_frames(), "physics_frames": Engine.get_physics_frames(), "paused": get_tree().paused}
	if command == "events":
		var result: Array = []
		for event in _events:
			if event.sequence > int(p.get("after", 0)): result.append(event)
		return {"events": result, "cursor": _sequence}
	if command == "reproduce":
		if _busy: return {"error": "A frame operation is still running"}
		if not p.get("test") is Dictionary: return {"error": "Validated reproduction test required"}
		if not _frozen: _was_paused = get_tree().paused
		_frozen = true
		_busy = true
		var runner = load(get_script().resource_path.get_base_dir() + "/game-reproduce.gd").new()
		_reproduction = runner
		get_tree().create_timer(60.0, true, false, true).timeout.connect(func():
			if _reproduction == runner: runner.cancel())
		var result: Dictionary = await runner.run(self, p.test)
		if _reproduction == runner:
			_reproduction = null
			_busy = false
		return result
	if command == "freeze":
		if _reproduction != null: _reproduction.cancel()
		_step_generation += 1
		_busy = _reproduction != null
		if not _frozen: _was_paused = get_tree().paused
		_frozen = true
		get_tree().paused = true
		return {"frozen": true, "scope": "pausable SceneTree nodes only"}
	if command == "thaw":
		if _busy: return {"error": "A frame operation is running; freeze to cancel it first"}
		if _frozen: get_tree().paused = _was_paused
		_frozen = false
		return {"frozen": false}
	if command == "step":
		if not _frozen or _busy: return {"error": "Freeze first; only one step may run"}
		var frames := int(p.get("frames", 1))
		if frames < 1 or frames > 120: return {"error": "frames must be 1..120"}
		var clock := str(p.get("clock", "process"))
		if clock != "process" and clock != "physics": return {"error": "clock must be process or physics"}
		_busy = true
		_step_generation += 1
		var generation := _step_generation
		# A lost browser request must not leave the game running indefinitely.
		get_tree().create_timer(10.0, true, false, true).timeout.connect(func():
			if _busy and _step_generation == generation:
				_step_generation += 1
				_busy = false
				get_tree().paused = true)
		if clock == "physics":
			# physics_frame precedes scene callbacks. Start at one boundary,
			# stop at N+1: N callback AND solver steps have completed and synced.
			await get_tree().physics_frame
			if generation != _step_generation: return {"error": "Frame step interrupted; game remains paused"}
			get_tree().paused = false
			var completed := 0
			while completed < frames:
				await get_tree().physics_frame
				if generation != _step_generation: return {"error": "Frame step interrupted; game remains paused"}
				if get_tree().paused:
					_busy = false
					return {"error": "Game changed pause state during physics step; exact advance is not verified"}
				completed += 1
			get_tree().paused = true
			_busy = false
			return {"clock": clock, "requested_frames": frames, "observed_physics_ticks": completed, "paused": true, "scope": "pausable SceneTree nodes; process callbacks may also run between physics ticks", "deterministic": false}
		get_tree().paused = false
		var before := Engine.get_process_frames()
		while Engine.get_process_frames() - before < frames:
			await get_tree().process_frame
			if generation != _step_generation: return {"error": "Frame step interrupted; game remains paused"}
		get_tree().paused = true
		_busy = false
		return {"clock": clock, "requested_frames": frames, "observed_process_frames": Engine.get_process_frames() - before, "paused": true, "deterministic": false}

	var node := _node(str(p.get("node_path", "")))
	if command == "exists": return {"exists": node != null}
	if node == null: return {"error": "Node not found"}
	if command == "ui_target":
		if not node is Control or not node.is_visible_in_tree(): return {"error": "Visible Control required"}
		if node is BaseButton and node.disabled: return {"error": "Button disabled"}
		if node.get_viewport() != get_viewport(): return {"error": "SubViewport UI targeting is not supported"}
		var center = get_viewport().get_final_transform() * (node.get_global_transform_with_canvas() * (node.size * 0.5))
		var viewport := get_window().size
		return {"x": center.x, "y": center.y, "viewport_width": viewport.x, "viewport_height": viewport.y}
	if command == "state":
		var property := str(p.get("property", ""))
		if property.is_empty(): return {"path": str(node.get_path()), "class": node.get_class()}
		var observed := _property(node, property)
		if observed.has("error"): return observed
		return {"path": str(node.get_path()), "property": property, "value": observed.value}
	if command == "watch":
		var signal_name := str(p.get("signal", ""))
		if not node.has_signal(signal_name): return {"error": "Signal not found"}
		for previous in _subscriptions.keys():
			if _subscriptions[previous].get_ref() == null: _subscriptions.erase(previous)
		var key := str(node.get_instance_id()) + ":" + signal_name
		if not _subscriptions.has(key):
			if _subscriptions.size() >= 500: return {"error": "Signal subscription limit reached; stop and restart the game"}
			var count := 0
			for info in node.get_signal_list():
				if info.name == signal_name: count = info.args.size()
			var path := str(node.get_path())
			var cb := func():
				_sequence += 1
				_events.append({"sequence": _sequence, "node": path, "signal": signal_name, "frame": Engine.get_process_frames()})
				if _events.size() > 500: _events.pop_front()
			var connected := node.connect(signal_name, cb.unbind(count) if count > 0 else cb)
			if connected != OK: return {"error": "Signal subscription failed: " + str(connected)}
			_subscriptions[key] = weakref(node)
		return {"cursor": _sequence, "watching": signal_name}
	return {"error": "Unsupported command"}
