package orders

type InvoiceGateway interface {
	Issue(order Order)
}
