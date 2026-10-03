require 'rails_helper'
require_relative '../../app/models/order'

RSpec.describe Order do
  it 'totals' do
    expect(Order.new.total_cents).to eq(0)
  end
end
