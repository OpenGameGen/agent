extends SceneTree
# Application-owned staging configuration; never applied to the source project.
func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var config := ConfigFile.new()
	if config.load("res://project.godot") != OK:
		quit(1)
		return
	config.set_value("autoload", "OpenGameTest", "*res://opengame_test/bridge.gd")
	config.set_value("rendering", "renderer/rendering_method", "gl_compatibility")
	config.set_value("rendering", "renderer/rendering_method.mobile", "gl_compatibility")
	if args.size() > 0 and not args[0].is_empty():
		config.set_value("application", "run/main_scene", args[0])
	var main_scene = config.get_value("application", "run/main_scene", "")
	if not main_scene is String or main_scene.is_empty():
		printerr("Game startup requires application/run/main_scene in project.godot. Set it to an existing PackedScene (.tscn/.scn or uid://), or pass game_start scene with an existing .tscn path.")
		quit(1)
		return
	var scene = ResourceLoader.load(main_scene, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE_DEEP)
	if not scene is PackedScene:
		printerr("Game startup scene failed to load as PackedScene: %s. Fix application/run/main_scene or its dependencies, or pass a valid scene override. No game was started." % main_scene)
		quit(1)
		return
	if config.save("res://project.godot") != OK:
		quit(1)
		return
	quit(0)
