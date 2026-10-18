package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"example.com/shop/orders"
)

func Register(r *gin.Engine, service *orders.OrderService) {
	group := r.Group("/orders")
	group.GET("/:id", func(c *gin.Context) {
		id, _ := strconv.Atoi(c.Param("id"))
		c.JSON(http.StatusOK, service.Find(uint(id)))
	})
}
