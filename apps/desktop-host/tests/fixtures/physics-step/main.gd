extends Node
var physics_ticks := 0
var process_ticks := 0
func _physics_process(_delta: float) -> void:
	physics_ticks += 1
func _process(_delta: float) -> void:
	process_ticks += 1
func _ready() -> void:
	var body2 := RigidBody2D.new()
	body2.name = "Body2D"
	var shape2 := CollisionShape2D.new()
	shape2.shape = CircleShape2D.new()
	shape2.shape.radius = 10
	body2.add_child(shape2)
	add_child(body2)
	var floor2 := StaticBody2D.new()
	floor2.position.y = 200
	var floor_shape2 := CollisionShape2D.new()
	floor_shape2.shape = RectangleShape2D.new()
	floor_shape2.shape.size = Vector2(1000, 20)
	floor2.add_child(floor_shape2)
	add_child(floor2)
	var body3 := RigidBody3D.new()
	body3.name = "Body3D"
	var shape3 := CollisionShape3D.new()
	shape3.shape = SphereShape3D.new()
	shape3.shape.radius = 0.5
	body3.add_child(shape3)
	add_child(body3)
	var floor3 := StaticBody3D.new()
	floor3.position.y = -2
	var floor_shape3 := CollisionShape3D.new()
	floor_shape3.shape = BoxShape3D.new()
	floor_shape3.shape.size = Vector3(20, 0.2, 20)
	floor3.add_child(floor_shape3)
	add_child(floor3)
