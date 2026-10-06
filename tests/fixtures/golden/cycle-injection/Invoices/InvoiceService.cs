using Shop.Audit;
using Shop.Ledger;

namespace Shop.Invoices
{
    public class InvoiceService
    {
        private readonly LedgerService _ledger;
        private readonly AuditLog _audit;
        public InvoiceService(LedgerService ledger, AuditLog audit) { _ledger = ledger; _audit = audit; }
        public void Issue() { _ledger.Post(); }
    }
}
