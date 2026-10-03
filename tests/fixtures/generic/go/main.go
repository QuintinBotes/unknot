package main

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"example.com/shop/internal/store"
)

func getOrder(c *gin.Context) {
	c.JSON(200, gin.H{"id": c.Param("id")})
}

func createOrder(c *gin.Context) {
	c.Status(201)
}

func health(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}

func main() {
	r := gin.Default()
	r.GET("/orders/:id", getOrder)
	r.POST("/orders", createOrder)
	http.HandleFunc("/health", health)
	_ = store.Backup("/tmp/x.tgz")
	_ = r.Run()
}
