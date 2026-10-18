package invoices

import "example.com/shop/orders"

type PdfInvoiceGateway struct{}

func (g *PdfInvoiceGateway) Issue(order orders.Order) {}
