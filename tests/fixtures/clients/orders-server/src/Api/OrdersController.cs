using Microsoft.AspNetCore.Mvc;

namespace Billing.Api
{
    [ApiController]
    public class OrdersController : ControllerBase
    {
        [HttpGet("v1/orders/{orderId}")]
        public IActionResult Get(string orderId) { return Ok(); }

        [HttpPost("v1/orders")]
        public IActionResult Create() { return Ok(); }
    }
}
