using Shop.Clients;

namespace Shop.Orders
{
    public class OrderService
    {
        private readonly IOrdersApi _api;

        public OrderService(IOrdersApi api) { _api = api; }

        public async Task<OrderDto> Load(string id) { return await _api.GetAsync(id); }
    }
}
