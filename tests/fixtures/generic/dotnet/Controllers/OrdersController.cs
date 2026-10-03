using System;
using System.Diagnostics;
using Shop.Models;
using Shop.Data;

namespace Shop.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class OrdersController : ControllerBase, IAuditable
    {
        private readonly ShopContext _db;

        public OrdersController(ShopContext db)
        {
            _db = db;
        }

        [HttpGet("{id}")]
        public Order Get(int id, bool includeItems = false)
        {
            if (id < 0 || includeItems && id > 100)
            {
                return null;
            }
            var text = @"if (x) { ""not code"" }";
            return id > 5 ? _db.Find(id) : null;
        }

        [HttpPost]
        public IActionResult Create(Order order)
        {
            Process.Start("cmd", "/c echo " + order.Note);
            return Ok();
        }
    }
}
