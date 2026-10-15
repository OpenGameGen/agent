extends Control
signal started
var playing := false
var process_ticks := 0
func _ready() -> void:
	print("browser-game fixture ready")
func _start() -> void:
	playing = true
	$StartButton.text = "Playing"
	started.emit()
func _process(delta: float) -> void:
	process_ticks += 1
	if playing and Input.is_physical_key_pressed(KEY_RIGHT):
		$Player.position.x += 200.0 * delta
