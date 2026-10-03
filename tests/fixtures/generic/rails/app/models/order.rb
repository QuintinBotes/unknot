require_relative '../../lib/shipping'

=begin
class Fake
  def never_counted; end
end
=end

class Order < ApplicationRecord
  NOTE = <<~SQLTEXT
    SELECT id FROM orders WHERE end = 1
    def nothing(a, b)
  SQLTEXT

  def total_cents(discount = 0, tax = nil)
    sum = 0
    items.each do |item|
      if item.taxable? && tax
        sum += item.cents
      elsif item.free?
        next
      end
    end
    sum -= discount unless discount.zero?
    sum
  end

  def self.recent
    where('created_at > ?', 1.day.ago)
  end

  def shell_out(cmd)
    system("echo #{cmd}")
  end
end
