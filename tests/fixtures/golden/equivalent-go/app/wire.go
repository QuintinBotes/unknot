//go:build wireinject

package app

import (
	"github.com/google/wire"

	"example.com/shop/invoices"
	"example.com/shop/orders"
)

func InitializeOrderService() *orders.OrderService {
	wire.Build(
		orders.NewOrderService,
		wire.Struct(new(invoices.PdfInvoiceGateway)),
		wire.Bind(new(orders.InvoiceGateway), new(*invoices.PdfInvoiceGateway)),
	)
	return nil
}
