extends SceneTree
var bridge: Node
var scene: Node
func _initialize() -> void:
	call_deferred("run")
func run() -> void:
	Engine.max_fps = int(OS.get_environment("STEP_TEST_FPS"))
	bridge = load("res://bridge.gd").new()
	root.add_child(bridge)
	scene = load("res://main.gd").new()
	root.add_child(scene)
	await bridge._execute({"command": "freeze"})
	for frames in [1, 2, 60, 120, 1, 1]:
		var before: int = scene.physics_ticks
		var result: Dictionary = await bridge._execute({"command": "step", "frames": frames, "clock": "physics"})
		assert(not result.has("error"), str(result))
		assert(scene.physics_ticks - before == frames, str([frames, before, scene.physics_ticks]))
		assert(paused)
		var y2: float = scene.get_node("Body2D").position.y
		var y3: float = scene.get_node("Body3D").position.y
		await create_timer(0.05, true).timeout
		assert(scene.physics_ticks - before == frames)
		assert(scene.get_node("Body2D").position.y == y2)
		assert(scene.get_node("Body3D").position.y == y3)
		print("PHYSICS_STEP ", JSON.stringify({"frames": frames, "actual": scene.physics_ticks-before, "y2": y2, "y3": y3, "process": scene.process_ticks}))
	assert(abs(scene.get_node("Body2D").position.y - 180) < 2)
	assert(abs(scene.get_node("Body3D").position.y + 1.4) < 0.1)
	create_timer(0.05, true).timeout.connect(func(): bridge._execute({"command": "freeze"}))
	var canceled: Dictionary = await bridge._execute({"command": "step", "frames": 120, "clock": "physics"})
	assert(canceled.has("error"))
	assert(paused)
	var end_ticks: int = scene.physics_ticks
	await create_timer(0.1, true).timeout
	assert(scene.physics_ticks == end_ticks)
	print("PHYSICS_STEP_OK fps=", Engine.max_fps)
	quit()
