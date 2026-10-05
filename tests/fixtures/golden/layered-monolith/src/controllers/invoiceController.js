import { issueInvoice } from '../services/invoiceService.js';

export function createInvoice(req) {
  return issueInvoice(req.body);
}
