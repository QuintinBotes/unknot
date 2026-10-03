class AddStatusToOrders < ActiveRecord::Migration[7.1]
  def change
    add_column :orders, :status, :string, default: "new", null: false
    add_column :orders, :token, :uuid, default: -> { "gen_random_uuid()" }
  end
end
