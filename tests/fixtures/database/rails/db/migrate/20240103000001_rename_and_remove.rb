class RenameAndRemove < ActiveRecord::Migration[7.1]
  def up
    rename_column :orders, :total, :total_cents
    remove_column :orders, :legacy_flag
    execute "UPDATE orders SET total_cents = total_cents * 100"
  end

  def down
    raise ActiveRecord::IrreversibleMigration
  end
end
