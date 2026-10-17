using Microsoft.AspNetCore.Mvc;
using Shop.Orders;

namespace Shop.Api;

[ApiController]
[Route("orders")]
public class OrdersController : ControllerBase
{
    private readonly OrderService _service;

    public OrdersController(OrderService service)
    {
        _service = service;
    }

    [HttpGet("{id}")]
    public Order Get(int id) => _service.Find(id);
}
