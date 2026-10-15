extends Node
var ticks := 0
var presses := 0
var total := 0
var rng := RandomNumberGenerator.new()
var bad_rng := false
var break_pause := false
var scalar: Variant = 0
var poison := false
var accept_reset := true
func _opengame_reset(seed_value: int) -> bool:
	scalar = 0
	ticks = 0
	presses = 0
	total = 0
	if not bad_rng: rng.seed = seed_value
	get_node("/root/Global").count = 0
	if break_pause: get_tree().paused = false
	return accept_reset
func _physics_process(_delta: float) -> void:
	ticks += 1
	if poison: scalar = NAN
	if Input.is_action_just_pressed("ui_accept"): presses += 1
	if Input.is_action_pressed("ui_accept"):
		total += rng.randi_range(1, 100000)
		get_node("/root/Global").count += 1
