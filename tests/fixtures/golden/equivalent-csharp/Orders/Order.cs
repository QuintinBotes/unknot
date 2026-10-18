using System.ComponentModel.DataAnnotations.Schema;

namespace Shop.Orders;

[Table("orders")]
public class Order
{
    public int Id { get; set; }
}
