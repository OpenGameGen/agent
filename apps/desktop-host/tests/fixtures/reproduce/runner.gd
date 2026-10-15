extends SceneTree
func _initialize() -> void:
	call_deferred("run")
func run() -> void:
	var bridge = load("res://bridge.gd").new()
	root.add_child(bridge)
	var precise := {"trace": [{"tick": 0, "values": [1.000000000000001]}]}
	var rounded := {"trace": [{"tick": 0, "values": [1.0]}]}
	assert(bridge._encode_response("reproduce", precise) != bridge._encode_response("reproduce", rounded))
	assert(JSON.parse_string(bridge._encode_response("reproduce", precise)).trace[0].values[0] == 1.000000000000001)
	assert(bridge._encode_response("state", precise) == bridge._encode_response("state", rounded))
	print("REPRO_PRECISION_OK")
	var game = load("res://game.gd").new()
	game.name = "Main"
	root.add_child(game)
	var test := {"version": 1, "seed": int(OS.get_environment("REPRO_SEED")), "reset_node": "/root/Main", "observations": [{"node": "/root/Main", "property": "ticks"}, {"node": "/root/Main", "property": "presses"}, {"node": "/root/Main", "property": "total"}, {"node": "/root/Global", "property": "count"}], "steps": [{"actions_down": ["ui_accept"], "actions_up": [], "physics_ticks": 2}, {"actions_down": [], "actions_up": ["ui_accept"], "physics_ticks": 2}]}
	var result: Dictionary = await bridge._execute({"command": "reproduce", "test": test})
	assert(not result.has("error"), str(result))
	assert(result.trace[0].values == [0, 0, 0, 0])
	assert(result.trace[1].values[0] == 2 and result.trace[1].values[1] == 1 and result.trace[1].values[3] == 2, str(result))
	assert(result.trace[2].values[0] == 4 and result.trace[2].values[3] == 2)
	assert(paused and not Input.is_action_pressed("ui_accept"))
	print("REPRO_TRACE ", bridge._encode_response("reproduce", result))
	var again: Dictionary = await bridge._execute({"command": "reproduce", "test": test})
	assert(again.trace == result.trace)
	game.bad_rng = true
	var bad: Dictionary = await bridge._execute({"command": "reproduce", "test": test})
	assert(bad.trace != result.trace)
	game.bad_rng = false
	game.break_pause = true
	assert((await bridge._execute({"command": "reproduce", "test": test})).has("error"))
	game.break_pause = false
	assert(paused)
	test.reset_node = "/root/Global"
	assert((await bridge._execute({"command": "reproduce", "test": test})).has("error"))
	test.reset_node = "/root/Main"
	test.steps[0].actions_down = ["nonexistent_action"]
	assert((await bridge._execute({"command": "reproduce", "test": test})).has("error"))
	test.steps[0].actions_down = ["ui_accept"]
	test.observations[0].property = "missing_property"
	assert((await bridge._execute({"command": "reproduce", "test": test})).has("error"))
	test.observations[0].property = "ticks"
	game.accept_reset = false
	assert((await bridge._execute({"command": "reproduce", "test": test})).has("error"))
	game.accept_reset = true
	game.poison = true
	test.observations[0].property = "scalar"
	assert((await bridge._execute({"command": "reproduce", "test": test})).has("error"))
	assert(paused and not Input.is_action_pressed("ui_accept"))
	game.poison = false
	test.observations[0].property = "ticks"
	test.steps[0].physics_ticks = 120
	create_timer(0.08, true).timeout.connect(func(): bridge._execute({"command": "freeze"}))
	var canceled: Dictionary = await bridge._execute({"command": "reproduce", "test": test})
	assert(canceled.has("error"))
	assert(paused and not Input.is_action_pressed("ui_accept"))
	var before: int = game.ticks
	await create_timer(0.05, true).timeout
	assert(game.ticks == before)
	print("REPRO_OK")
	quit()
