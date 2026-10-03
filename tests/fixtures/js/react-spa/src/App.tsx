import { Routes, Route } from 'react-router-dom';
import { Layout } from './shared/Layout';
import { Profile } from './features/user/Profile';
import Home from './features/home/Home';

export function App() {
  return (
    <Routes>
      <Route path="/app" element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="profile" element={<Profile />} />
      </Route>
    </Routes>
  );
}
