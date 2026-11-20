package orders

type OrderService struct {
	invoices InvoiceGateway
}

func NewOrderService(invoices InvoiceGateway) *OrderService {
	return &OrderService{invoices: invoices}
}

func (s *OrderService) Find(id uint) Order {
	order := Order{ID: id}
	s.invoices.Issue(order)
	return order
}
