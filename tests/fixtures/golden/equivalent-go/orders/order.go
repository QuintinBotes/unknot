package orders

type Order struct {
	ID uint `gorm:"primaryKey"`
}

func (Order) TableName() string {
	return "orders"
}
