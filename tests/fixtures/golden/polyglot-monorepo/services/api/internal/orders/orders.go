package orders

import "github.com/gin-gonic/gin"

func Get(c *gin.Context) {
	c.JSON(200, gin.H{"id": c.Param("id")})
}

func Create(c *gin.Context) {
	c.Status(201)
}
