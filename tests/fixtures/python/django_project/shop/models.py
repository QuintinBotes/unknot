from django.db import models


class Customer(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(null=True)

    class Meta:
        db_table = 'shop_customers'


class Product(models.Model):
    title = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=8, decimal_places=2)
    owner = models.ForeignKey('Customer', on_delete=models.CASCADE)
