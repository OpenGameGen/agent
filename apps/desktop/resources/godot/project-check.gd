# Application-owned script loader: initialize configured autoloads, but never
# instantiate the main scene or the scripts being checked. CLI detects logged
# parser errors even when ResourceLoader returns a non-null invalid script.
extends SceneTree

var checked = false

func _process(_delta: float) -> bool:
	if checked:
		return false
	checked = true
	var failed = false
	var args = OS.get_cmdline_user_args()
	if args.size() != 1:
		push_error("Expected one product-owned script manifest")
		quit(1)
		return false
	var scripts = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if not scripts is Array:
		push_error("Invalid project script manifest")
		quit(1)
		return false
	for path in scripts:
		if not path is String or not path.begins_with("res://"):
			push_error("Invalid project script path")
			failed = true
			continue
		if ResourceLoader.load(path, "Script") == null:
			push_error("Cannot load project script: " + path)
			failed = true
	print("OPENGAME_PROJECT_CHECK_COMPLETE")
	quit(1 if failed else 0)
	return false
