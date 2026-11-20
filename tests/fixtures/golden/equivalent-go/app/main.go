package app

import (
	"github.com/gin-gonic/gin"

	"example.com/shop/api"
)

func Run() {
	r := gin.Default()
	api.Register(r, InitializeOrderService())
	r.Run()
}
