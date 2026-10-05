import { saveOrder } from '../repositories/orderRepository.js';

export function placeOrder(input) {
  const errors = [];
  if (!input) {
    errors.push('missing body');
  }
  if (input && typeof input.customerId !== 'string') {
    errors.push('customerId must be a string');
  }
  if (input && input.customerId && input.customerId.length > 64) {
    errors.push('customerId too long');
  }
  if (input && !Array.isArray(input.lines)) {
    errors.push('lines must be an array');
  }
  if (input && Array.isArray(input.lines) && input.lines.length === 0) {
    errors.push('lines must not be empty');
  }
  if (input && Array.isArray(input.lines)) {
    for (const line of input.lines) {
      if (typeof line.sku !== 'string') {
        errors.push('sku must be a string');
      }
      if (typeof line.quantity !== 'number' || line.quantity <= 0) {
        errors.push('quantity must be positive');
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return saveOrder(input);
}
