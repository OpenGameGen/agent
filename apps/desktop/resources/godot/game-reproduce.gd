extends RefCounted
# Controlled input/observation contract, not a world snapshot or deterministic engine.
var bridge: Node
var held: Dictionary = {}
var canceled := false
var error := ""

func cancel() -> void:
	canceled = true
	cleanup()

func cleanup() -> void:
	for action in held: Input.action_release(action)
	held.clear()
	if is_instance_valid(bridge):
		bridge.get_tree().paused = true

func fail(message: String) -> Dictionary:
	cleanup()
	return {"error": message, "paused": true, "deterministic": false}

func encode(value: Variant, depth: int = 0) -> Variant:
	if depth > 8:
		error = "Observation nesting exceeds 8"
		return null
	if value == null or value is bool: return value
	if value is int:
		if value > 9007199254740991 or value < -9007199254740991: error = "Observation integer exceeds safe JSON range"
		return value
	if value is float:
		if not is_finite(value): error = "Observation must be finite"
		return value
	if value is String or value is StringName:
		if str(value).length() > 4096: error = "Observation string exceeds 4096"
		return str(value)
	if value is Vector2 or value is Vector2i: return encode({"x": value.x, "y": value.y}, depth + 1)
	if value is Vector3 or value is Vector3i: return encode({"x": value.x, "y": value.y, "z": value.z}, depth + 1)
	if value is Array:
		if value.size() > 64:
			error = "Observation array exceeds 64"
			return null
		var result: Array = []
		for item in value: result.append(encode(item, depth + 1))
		return result
	if value is Dictionary:
		if value.size() > 64:
			error = "Observation dictionary exceeds 64"
			return null
		var result := {}
		for key in value:
			if not key is String and not key is StringName: error = "Observation dictionary keys must be strings"
			result[str(key)] = encode(value[key], depth + 1)
		return result
	error = "Observation must be finite JSON or a supported vector, not an Object"
	return null

func sample(observations: Array, tick: int) -> Dictionary:
	var values: Array = []
	for item in observations:
		var node: Node = bridge._node(str(item.node))
		if node == null:
			error = "Observation node not found: " + str(item.node)
			break
		var observed: Dictionary = bridge._property(node, str(item.property), false)
		if observed.has("error"):
			error = str(observed.error)
			break
		values.append(encode(observed.value))
		if not error.is_empty(): break
	var result := {"tick": tick, "values": values}
	if JSON.stringify(result, "", true, true).to_utf8_buffer().size() > 65536: error = "Sample exceeds 64 KiB"
	return result

func run(owner: Node, test: Dictionary) -> Dictionary:
	bridge = owner
	bridge.get_tree().paused = true
	var reset: Node = bridge._node(str(test.get("reset_node", "")))
	if reset == null or not reset.has_method("_opengame_reset"): return fail("reset_node must implement synchronous _opengame_reset(seed) returning true")
	for method in reset.get_method_list():
		if method.name == "_opengame_reset" and (method.args.size() != 1 or int(method.flags) & METHOD_FLAG_VARARG):
			return fail("_opengame_reset must accept exactly one seed argument")
		if method.name == "_opengame_reset" and int(method.args[0].type) not in [TYPE_NIL, TYPE_INT]:
			return fail("_opengame_reset seed argument must accept an integer")
	if not test.get("observations") is Array or not test.get("steps") is Array: return fail("Validated observations and steps required")
	var actions: Dictionary = {}
	for segment in test.steps:
		for field in ["actions_down", "actions_up"]:
			for action in segment.get(field, []):
				if not InputMap.has_action(action): return fail("Unknown InputMap action: " + str(action))
				actions[action] = true
	# Never release a key held by someone else. Explicit reset may reset project state,
	# but actions controlled by this request must begin released.
	for action in actions:
		if Input.is_action_pressed(action): return fail("Action already pressed before reproduction: " + str(action))
	var reset_result: Variant = reset.call("_opengame_reset", int(test.seed))
	if not reset_result is bool or reset_result != true: return fail("_opengame_reset(seed) must synchronously return true")
	if not bridge.get_tree().paused: return fail("Reset changed paused state; reset must leave the tree paused")
	for action in actions:
		if Input.is_action_pressed(action): return fail("Reset changed input state: " + str(action))
	var trace: Array = [sample(test.observations, 0)]
	if not error.is_empty(): return fail(error)
	var tick := 0
	for segment in test.steps:
		# Apply at this exact boundary, not before await: just_pressed must survive
		# to the upcoming _physics_process callback.
		await bridge.get_tree().physics_frame
		if canceled: return fail("Reproduction canceled; actions released and tree paused")
		for action in segment.actions_up:
			if held.has(action):
				Input.action_release(action)
				held.erase(action)
		for action in segment.actions_down:
			if not held.has(action):
				Input.action_press(action)
				held[action] = true
		bridge.get_tree().paused = false
		for index in range(int(segment.physics_ticks)):
			await bridge.get_tree().physics_frame
			if canceled: return fail("Reproduction canceled; actions released and tree paused")
			if bridge.get_tree().paused: return fail("Game changed paused state during reproduction")
			tick += 1
		bridge.get_tree().paused = true
		trace.append(sample(test.observations, tick))
		if not error.is_empty(): return fail(error)
		if JSON.stringify(trace, "", true, true).to_utf8_buffer().size() > 100000: return fail("Bridge reproduction trace exceeds 100 KiB; use fewer observations or steps")
	cleanup()
	return {"trace": trace, "paused": true, "physics": {"ticks_per_second": Engine.physics_ticks_per_second, "max_steps_per_frame": Engine.max_physics_steps_per_frame, "time_scale": Engine.time_scale}, "declared_scope": "Project synchronous reset contract, InputMap action polling and supplied observed properties only; project owns Autoloads, RNGs, timers and initialization side effects. Not a world snapshot, browser keyboard event test or cross-platform determinism.", "deterministic": false}
