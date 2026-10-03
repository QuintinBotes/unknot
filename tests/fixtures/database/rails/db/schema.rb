ActiveRecord::Schema[7.1].define(version: 2024_01_03_000001) do
  create_table "customers", force: :cascade do |t|
    t.string "email", null: false
    t.datetime "created_at", null: false
  end

  create_table "orders", force: :cascade do |t|
    t.bigint "customer_id", null: false
    t.integer "total_cents", default: 0, null: false
    t.index ["customer_id"], name: "index_orders_on_customer_id"
  end

  add_foreign_key "orders", "customers"
end
