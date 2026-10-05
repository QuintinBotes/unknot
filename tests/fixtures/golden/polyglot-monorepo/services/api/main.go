package main

import (
	"github.com/gin-gonic/gin"

	"example.com/shop/internal/orders"
)

func main() {
	r := gin.Default()
	r.GET("/orders/:id", orders.Get)
	r.POST("/orders", orders.Create)
	_ = r.Run()
}
